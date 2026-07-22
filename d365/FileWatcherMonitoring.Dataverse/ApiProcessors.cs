using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Query;
using FileWatcherMonitoring.Plugins;

namespace FileWatcherMonitoring.Dataverse
{
    /// <summary>
    /// API entry-point monitoring, Dataverse side. Message rows in fwm_apimessage are
    /// their own state (unlike files, where observations and state are separate —
    /// a message has identity, a file sighting doesn't). Events append to
    /// fwm_apievent. All writes ride the caller's pipeline transaction.
    /// </summary>
    public static class ApiMessageProcessor
    {
        public const string HeartbeatSentinelId = "__heartbeat__";

        /// <returns>The new status recorded, or null when the report was a no-op.</returns>
        public static ApiStatus? Report(IOrganizationService service, string interfaceId, string messageId,
            ApiReportAction action, string correlationId, string errorCode, DateTime utcNow)
        {
            var existing = Get(service, interfaceId, messageId);
            var engine = new ApiMessageEngine();
            var newState = engine.Decide(action, interfaceId, messageId, correlationId, errorCode, existing, utcNow);
            if (newState == null)
            {
                return null;
            }
            Upsert(service, newState);
            service.Create(ToEvent(newState, utcNow));
            return newState.CurrentStatus;
        }

        /// <summary>Timeout sweep + feed heartbeat for one interface. Returns events created.</summary>
        public static int CheckSla(IOrganizationService service, string interfaceId, DateTime utcNow)
        {
            var config = ConfigLoader.LoadByInterfaceId(service, interfaceId);
            var created = 0;

            // 1. In-flight messages past the processing timeout -> MSG_TIMEOUT.
            var timeoutSeconds = config.ProcessingTimeoutSeconds;
            if (timeoutSeconds > 0)
            {
                foreach (var state in FindByStatus(service, interfaceId, ApiStatus.MSG_RECEIVED))
                {
                    if (!ApiMessageEngine.IsTimedOut(state, timeoutSeconds, utcNow))
                    {
                        continue;
                    }
                    ApiTransitionPolicy.AssertValidTransition(state.CurrentStatus, ApiStatus.MSG_TIMEOUT);
                    state.PreviousStatus = state.CurrentStatus;
                    state.CurrentStatus = ApiStatus.MSG_TIMEOUT;
                    state.StatusChangedAt = utcNow;
                    Upsert(service, state);
                    service.Create(ToEvent(state, utcNow));
                    created++;
                }
            }

            // 2. Feed heartbeat: nothing received today past the SLA deadline -> one
            //    FEED_MISSING_BY_SLA, sentinel-row idempotent (same pattern as files).
            if (!string.IsNullOrEmpty(config.SlaDeadline))
            {
                created += CheckHeartbeat(service, config, utcNow);
            }
            return created;
        }

        private static int CheckHeartbeat(IOrganizationService service, InterfaceConfig config, DateTime now)
        {
            var deadlineParts = config.SlaDeadline.Split(':');
            var deadline = new DateTime(now.Year, now.Month, now.Day,
                int.Parse(deadlineParts[0]), int.Parse(deadlineParts[1]), 0, DateTimeKind.Utc);
            if (now < deadline)
            {
                return 0;
            }

            var anyToday = false;
            foreach (var state in FindByInterface(service, config.InterfaceId))
            {
                if (state.MessageId != HeartbeatSentinelId && SameUtcDay(state.ReceivedAt, now))
                {
                    anyToday = true;
                    break;
                }
            }
            if (anyToday)
            {
                return 0;
            }

            var sentinel = Get(service, config.InterfaceId, HeartbeatSentinelId);
            if (sentinel != null && sentinel.CurrentStatus == ApiStatus.FEED_MISSING_BY_SLA
                && SameUtcDay(sentinel.StatusChangedAt, now))
            {
                return 0;
            }

            var previous = sentinel != null ? sentinel.CurrentStatus : (ApiStatus?)null;
            ApiTransitionPolicy.AssertValidTransition(previous, ApiStatus.FEED_MISSING_BY_SLA);
            var newSentinel = new ApiMessageState
            {
                InterfaceId = config.InterfaceId,
                MessageId = HeartbeatSentinelId,
                CurrentStatus = ApiStatus.FEED_MISSING_BY_SLA,
                PreviousStatus = previous,
                BatchId = Guid.NewGuid().ToString(),
                ReceivedAt = now,
                StatusChangedAt = now
            };
            Upsert(service, newSentinel);
            service.Create(ToEvent(newSentinel, now, messageIdOverrideNull: true));
            return 1;
        }

        private static bool SameUtcDay(DateTime a, DateTime b)
        {
            return a.Year == b.Year && a.Month == b.Month && a.Day == b.Day;
        }

        // ------------------------------------------------------------- storage ----

        private static ApiMessageState Get(IOrganizationService service, string interfaceId, string messageId)
        {
            var query = new QueryExpression(Schema.ApiMessageTable.LogicalName)
            {
                ColumnSet = new ColumnSet(true),
                TopCount = 1
            };
            query.Criteria.AddCondition(Schema.ApiMessageTable.InterfaceId, ConditionOperator.Equal, interfaceId);
            query.Criteria.AddCondition(Schema.ApiMessageTable.MessageId, ConditionOperator.Equal, messageId);
            var results = service.RetrieveMultiple(query);
            return results.Entities.Count == 0 ? null : ToState(results.Entities[0]);
        }

        private static IEnumerable<ApiMessageState> FindByInterface(IOrganizationService service, string interfaceId)
        {
            var query = new QueryExpression(Schema.ApiMessageTable.LogicalName) { ColumnSet = new ColumnSet(true) };
            query.Criteria.AddCondition(Schema.ApiMessageTable.InterfaceId, ConditionOperator.Equal, interfaceId);
            foreach (var entity in service.RetrieveMultiple(query).Entities)
            {
                yield return ToState(entity);
            }
        }

        private static IEnumerable<ApiMessageState> FindByStatus(IOrganizationService service, string interfaceId, ApiStatus status)
        {
            var query = new QueryExpression(Schema.ApiMessageTable.LogicalName) { ColumnSet = new ColumnSet(true) };
            query.Criteria.AddCondition(Schema.ApiMessageTable.InterfaceId, ConditionOperator.Equal, interfaceId);
            query.Criteria.AddCondition(Schema.ApiMessageTable.CurrentStatus, ConditionOperator.Equal, Schema.ToChoice(status));
            foreach (var entity in service.RetrieveMultiple(query).Entities)
            {
                yield return ToState(entity);
            }
        }

        private static void Upsert(IOrganizationService service, ApiMessageState state)
        {
            var entity = new Entity(Schema.ApiMessageTable.LogicalName);
            entity.KeyAttributes[Schema.ApiMessageTable.InterfaceId] = state.InterfaceId;
            entity.KeyAttributes[Schema.ApiMessageTable.MessageId] = state.MessageId;

            entity[Schema.ApiMessageTable.InterfaceId] = state.InterfaceId;
            entity[Schema.ApiMessageTable.MessageId] = state.MessageId;
            entity[Schema.ApiMessageTable.CorrelationId] = state.CorrelationId;
            entity[Schema.ApiMessageTable.CurrentStatus] = new OptionSetValue(Schema.ToChoice(state.CurrentStatus));
            entity[Schema.ApiMessageTable.PreviousStatus] = state.PreviousStatus.HasValue
                ? new OptionSetValue(Schema.ToChoice(state.PreviousStatus.Value)) : null;
            entity[Schema.ApiMessageTable.BatchId] = state.BatchId;
            entity[Schema.ApiMessageTable.ReceivedAt] = state.ReceivedAt;
            entity[Schema.ApiMessageTable.ProcessedAt] = state.ProcessedAt;
            entity[Schema.ApiMessageTable.ErrorCode] = state.ErrorCode;
            entity[Schema.ApiMessageTable.StatusChangedAt] = state.StatusChangedAt;

            service.Execute(new UpsertRequest { Target = entity });
        }

        private static ApiMessageState ToState(Entity entity)
        {
            var previous = entity.GetAttributeValue<OptionSetValue>(Schema.ApiMessageTable.PreviousStatus);
            return new ApiMessageState
            {
                InterfaceId = entity.GetAttributeValue<string>(Schema.ApiMessageTable.InterfaceId),
                MessageId = entity.GetAttributeValue<string>(Schema.ApiMessageTable.MessageId),
                CorrelationId = entity.GetAttributeValue<string>(Schema.ApiMessageTable.CorrelationId),
                CurrentStatus = Schema.ApiFromChoice(entity.GetAttributeValue<OptionSetValue>(Schema.ApiMessageTable.CurrentStatus).Value),
                PreviousStatus = previous != null ? Schema.ApiFromChoice(previous.Value) : (ApiStatus?)null,
                BatchId = entity.GetAttributeValue<string>(Schema.ApiMessageTable.BatchId),
                ReceivedAt = entity.GetAttributeValue<DateTime>(Schema.ApiMessageTable.ReceivedAt),
                ProcessedAt = entity.GetAttributeValue<DateTime?>(Schema.ApiMessageTable.ProcessedAt),
                ErrorCode = entity.GetAttributeValue<string>(Schema.ApiMessageTable.ErrorCode),
                StatusChangedAt = entity.GetAttributeValue<DateTime>(Schema.ApiMessageTable.StatusChangedAt)
            };
        }

        private static Entity ToEvent(ApiMessageState state, DateTime now, bool messageIdOverrideNull = false)
        {
            var entity = new Entity(Schema.ApiEventTable.LogicalName);
            entity[Schema.ApiEventTable.EventId] = Guid.NewGuid().ToString();
            entity[Schema.ApiEventTable.EventType] = new OptionSetValue(Schema.ToChoice(state.CurrentStatus));
            entity[Schema.ApiEventTable.BatchId] = state.BatchId;
            entity[Schema.ApiEventTable.InterfaceId] = state.InterfaceId;
            entity[Schema.ApiEventTable.MessageId] = messageIdOverrideNull ? null : state.MessageId;
            entity[Schema.ApiEventTable.OccurredAt] = now;
            return entity;
        }
    }
}
