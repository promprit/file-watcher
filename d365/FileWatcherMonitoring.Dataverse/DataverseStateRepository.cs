using System;
using System.Collections.Generic;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Query;
using FileWatcherMonitoring.Plugins;

namespace FileWatcherMonitoring.Dataverse
{
    /// <summary>
    /// IStateRepository backed by Dataverse (fwm_filestate). Replaces the Postgres
    /// ON CONFLICT upsert with an alternate-key UpsertRequest on
    /// (fwm_interfaceid, fwm_filepath). Runs on the plugin pipeline's
    /// IOrganizationService, so all writes join the pipeline transaction.
    /// </summary>
    public class DataverseStateRepository : IStateRepository
    {
        private readonly IOrganizationService _service;

        public DataverseStateRepository(IOrganizationService service)
        {
            _service = service;
        }

        public WatcherState Get(string interfaceId, string filePath)
        {
            var query = new QueryExpression(Schema.FileState.LogicalName)
            {
                ColumnSet = new ColumnSet(true),
                TopCount = 1
            };
            query.Criteria.AddCondition(Schema.FileState.InterfaceId, ConditionOperator.Equal, interfaceId);
            query.Criteria.AddCondition(Schema.FileState.FilePath, ConditionOperator.Equal, filePath);

            var results = _service.RetrieveMultiple(query);
            return results.Entities.Count == 0 ? null : ToState(results.Entities[0]);
        }

        public void Save(WatcherState state)
        {
            var entity = new Entity(Schema.FileState.LogicalName);
            // Alternate key on (fwm_interfaceid, fwm_filepath) drives the upsert.
            entity.KeyAttributes[Schema.FileState.InterfaceId] = state.InterfaceId;
            entity.KeyAttributes[Schema.FileState.FilePath] = state.FilePath;

            entity[Schema.FileState.InterfaceId] = state.InterfaceId;
            entity[Schema.FileState.FilePath] = state.FilePath;
            entity[Schema.FileState.FileName] = state.FileName;
            entity[Schema.FileState.FileSizeBytes] = state.FileSizeBytes;
            entity[Schema.FileState.BatchId] = state.BatchId;
            entity[Schema.FileState.CurrentStatus] = new OptionSetValue(Schema.ToChoice(state.CurrentStatus));
            entity[Schema.FileState.PreviousStatus] = state.PreviousStatus.HasValue
                ? new OptionSetValue(Schema.ToChoice(state.PreviousStatus.Value))
                : null;
            entity[Schema.FileState.StatusChangedAt] = state.StatusChangedAt;
            entity[Schema.FileState.FirstDetectedAt] = state.FirstDetectedAt;
            entity[Schema.FileState.LastSeenAt] = state.LastSeenAt;

            _service.Execute(new UpsertRequest { Target = entity });
        }

        public IReadOnlyList<WatcherState> FindByInterface(string interfaceId)
        {
            var query = new QueryExpression(Schema.FileState.LogicalName)
            {
                ColumnSet = new ColumnSet(true)
            };
            query.Criteria.AddCondition(Schema.FileState.InterfaceId, ConditionOperator.Equal, interfaceId);

            var results = _service.RetrieveMultiple(query);
            var states = new List<WatcherState>(results.Entities.Count);
            foreach (var entity in results.Entities)
            {
                states.Add(ToState(entity));
            }
            return states;
        }

        private static WatcherState ToState(Entity entity)
        {
            var previous = entity.GetAttributeValue<OptionSetValue>(Schema.FileState.PreviousStatus);
            return new WatcherState
            {
                InterfaceId = entity.GetAttributeValue<string>(Schema.FileState.InterfaceId),
                FilePath = entity.GetAttributeValue<string>(Schema.FileState.FilePath),
                FileName = entity.GetAttributeValue<string>(Schema.FileState.FileName),
                FileSizeBytes = entity.GetAttributeValue<long>(Schema.FileState.FileSizeBytes),
                BatchId = entity.GetAttributeValue<string>(Schema.FileState.BatchId),
                CurrentStatus = Schema.FromChoice(entity.GetAttributeValue<OptionSetValue>(Schema.FileState.CurrentStatus).Value),
                PreviousStatus = previous != null ? Schema.FromChoice(previous.Value) : (FileStatus?)null,
                StatusChangedAt = entity.GetAttributeValue<DateTime>(Schema.FileState.StatusChangedAt),
                FirstDetectedAt = entity.GetAttributeValue<DateTime>(Schema.FileState.FirstDetectedAt),
                LastSeenAt = entity.GetAttributeValue<DateTime>(Schema.FileState.LastSeenAt)
            };
        }
    }
}
