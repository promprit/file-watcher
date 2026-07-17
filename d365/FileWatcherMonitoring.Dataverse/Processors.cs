using System;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;
using FileWatcherMonitoring.Plugins;

namespace FileWatcherMonitoring.Dataverse
{
    /// <summary>
    /// The full observation-processing path, extracted from the IPlugin wrapper so
    /// it can run under xunit against a fake IOrganizationService (the wrapper only
    /// adds pipeline plumbing). Same-transaction guarantee comes from the caller's
    /// service being the pipeline service.
    /// </summary>
    public static class ObservationProcessor
    {
        /// <returns>The created FileEvent, or null when nothing meaningful changed.</returns>
        public static FileEvent Process(IOrganizationService service, Entity observationRow, DateTime utcNow)
        {
            var observation = new FileObservation
            {
                InterfaceId = observationRow.GetAttributeValue<string>(Schema.FileObservationTable.InterfaceId),
                Path = observationRow.GetAttributeValue<string>(Schema.FileObservationTable.FilePath),
                Size = observationRow.GetAttributeValue<long>(Schema.FileObservationTable.FileSizeBytes),
                Mtime = observationRow.GetAttributeValue<DateTime>(Schema.FileObservationTable.ModifiedAt)
            };

            var config = ConfigLoader.LoadByInterfaceId(service, observation.InterfaceId);

            var engine = new WatcherEngine(new DataverseStateRepository(service));
            var fileEvent = engine.ProcessObservation(observation, config, utcNow);

            if (fileEvent != null)
            {
                service.Create(EventWriter.ToEntity(fileEvent));
            }
            return fileEvent;
        }
    }

    /// <summary>Missing-SLA sweep path for one interface — body of Custom API fwm_CheckMissingSla.</summary>
    public static class SweepProcessor
    {
        /// <returns>Number of FILE_MISSING_BY_SLA events created (0 or 1 per sentinel idempotency).</returns>
        public static int Run(IOrganizationService service, string interfaceId, DateTime utcNow)
        {
            var config = ConfigLoader.LoadByInterfaceId(service, interfaceId);

            var sweep = new MissingSlaSweep(new DataverseStateRepository(service));
            var events = sweep.CheckMissingSla(config, utcNow);

            foreach (var fileEvent in events)
            {
                service.Create(EventWriter.ToEntity(fileEvent));
            }
            return events.Length;
        }
    }

    public static class ConfigLoader
    {
        public static InterfaceConfig LoadByInterfaceId(IOrganizationService service, string interfaceId)
        {
            var query = new QueryExpression(Schema.InterfaceTable.LogicalName)
            {
                ColumnSet = new ColumnSet(true),
                TopCount = 1
            };
            query.Criteria.AddCondition(Schema.InterfaceTable.InterfaceId, ConditionOperator.Equal, interfaceId);

            var results = service.RetrieveMultiple(query);
            if (results.Entities.Count == 0)
            {
                throw new InvalidPluginExecutionException("No fwm_interface row found for interface id " + interfaceId);
            }
            var row = results.Entities[0];

            return new InterfaceConfig
            {
                InterfaceId = row.GetAttributeValue<string>(Schema.InterfaceTable.InterfaceId),
                InterfaceName = row.GetAttributeValue<string>(Schema.InterfaceTable.Name),
                InboundPath = row.GetAttributeValue<string>(Schema.InterfaceTable.InboundPath),
                FilePattern = row.GetAttributeValue<string>(Schema.InterfaceTable.FilePattern),
                PollIntervalSeconds = row.GetAttributeValue<int>(Schema.InterfaceTable.PollIntervalSeconds),
                StabilityCheckSeconds = row.GetAttributeValue<int>(Schema.InterfaceTable.StabilityCheckSeconds),
                DuplicateCheckEnabled = row.GetAttributeValue<bool>(Schema.InterfaceTable.DuplicateCheckEnabled),
                StuckThresholdSeconds = row.GetAttributeValue<int>(Schema.InterfaceTable.StuckThresholdSeconds),
                SlaDeadline = row.GetAttributeValue<string>(Schema.InterfaceTable.SlaDeadline),
                EnabledFlag = row.GetAttributeValue<bool>(Schema.InterfaceTable.Enabled)
            };
        }
    }

    public static class EventWriter
    {
        public static Entity ToEntity(FileEvent fileEvent)
        {
            var entity = new Entity(Schema.FileEventTable.LogicalName);
            entity[Schema.FileEventTable.EventId] = fileEvent.EventId;
            entity[Schema.FileEventTable.EventType] = new OptionSetValue(Schema.ToChoice(fileEvent.EventType));
            entity[Schema.FileEventTable.BatchId] = fileEvent.BatchId;
            entity[Schema.FileEventTable.InterfaceId] = fileEvent.InterfaceId;
            entity[Schema.FileEventTable.FilePath] = fileEvent.FilePath;
            entity[Schema.FileEventTable.OccurredAt] = fileEvent.OccurredAt;
            return entity;
        }
    }
}
