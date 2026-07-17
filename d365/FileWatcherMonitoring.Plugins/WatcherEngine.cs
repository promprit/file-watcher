using System;

namespace FileWatcherMonitoring.Plugins
{
    /// <summary>Port of engine/batch-id.generator.ts.</summary>
    public static class BatchIdGenerator
    {
        public static string NewBatchId()
        {
            return Guid.NewGuid().ToString();
        }
    }

    /// <summary>Port of engine/interface-matcher.ts.</summary>
    public static class InterfaceMatcher
    {
        public static void AssertMatch(FileObservation observation, InterfaceConfig config)
        {
            if (observation.InterfaceId != config.InterfaceId)
            {
                throw new InterfaceMismatchException(observation.Path, config.InterfaceId);
            }
        }
    }

    /// <summary>Port of engine/event-builder.ts. Fresh EventId per call.</summary>
    public static class EventBuilder
    {
        public static FileEvent Build(FileObservation observation, FileStatus status, string batchId, DateTime now)
        {
            return new FileEvent
            {
                EventId = Guid.NewGuid().ToString(),
                EventType = status,
                BatchId = batchId,
                InterfaceId = observation.InterfaceId,
                FilePath = observation.Path,
                OccurredAt = now
            };
        }
    }

    /// <summary>
    /// Port of engine/watcher-engine.ts processObservation(). Pipeline order
    /// duplicate → stuck-file → stability, first non-null wins; implicit
    /// FILE_DETECTED for brand-new files; null (no event) when nothing
    /// meaningful changed. State save + event build share the caller's
    /// transaction (in Dataverse: the plugin pipeline transaction).
    /// </summary>
    public class WatcherEngine
    {
        private static readonly IRule[] Pipeline =
        {
            new DuplicateRule(),
            new StuckFileRule(),
            new StabilityRule()
        };

        private readonly IStateRepository _stateRepo;

        public WatcherEngine(IStateRepository stateRepo)
        {
            _stateRepo = stateRepo;
        }

        public FileEvent ProcessObservation(FileObservation observation, InterfaceConfig interfaceConfig, DateTime now)
        {
            InterfaceMatcher.AssertMatch(observation, interfaceConfig);

            var existingState = _stateRepo.Get(observation.InterfaceId, observation.Path);

            FileStatus? proposedStatus = null;
            foreach (var rule in Pipeline)
            {
                var outcome = rule.Evaluate(observation, existingState, interfaceConfig, now);
                if (outcome.HasValue)
                {
                    proposedStatus = outcome;
                    break;
                }
            }

            if (!proposedStatus.HasValue)
            {
                if (existingState != null)
                {
                    return null;
                }
                proposedStatus = FileStatus.FILE_DETECTED;
            }

            FileStatus? currentStatus = existingState != null ? existingState.CurrentStatus : (FileStatus?)null;

            if (currentStatus.HasValue && proposedStatus.Value == currentStatus.Value)
            {
                return null;
            }

            StateTransitionPolicy.AssertValidTransition(currentStatus, proposedStatus.Value);

            var batchId = existingState != null ? existingState.BatchId : BatchIdGenerator.NewBatchId();

            var newState = new WatcherState
            {
                InterfaceId = observation.InterfaceId,
                FilePath = observation.Path,
                CurrentStatus = proposedStatus.Value,
                PreviousStatus = currentStatus,
                BatchId = batchId,
                FirstDetectedAt = existingState != null ? existingState.FirstDetectedAt : now,
                StatusChangedAt = now,
                LastSeenAt = now,
                FileName = Basename(observation.Path),
                FileSizeBytes = observation.Size
            };

            _stateRepo.Save(newState);

            return EventBuilder.Build(observation, proposedStatus.Value, batchId, now);
        }

        /// <summary>Path-separator-agnostic basename (TS used node:path basename).</summary>
        internal static string Basename(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;
            var i = Math.Max(path.LastIndexOf('/'), path.LastIndexOf('\\'));
            return i >= 0 ? path.Substring(i + 1) : path;
        }
    }
}
