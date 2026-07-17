using System;

namespace FileWatcherMonitoring.Plugins
{
    /// <summary>
    /// Five-status file lifecycle. Member names intentionally match the TypeScript
    /// reference spec and the Dataverse choice labels exactly (FILE_DETECTED, ...).
    /// </summary>
    public enum FileStatus
    {
        FILE_DETECTED,
        FILE_STABLE,
        FILE_DUPLICATE,
        FILE_STUCK,
        FILE_MISSING_BY_SLA
    }

    /// <summary>Port of packages/contracts observations/file-observation.ts.</summary>
    public class FileObservation
    {
        public string InterfaceId { get; set; }
        public string Path { get; set; }
        public long Size { get; set; }
        public DateTime Mtime { get; set; }
    }

    /// <summary>Port of packages/contracts events/file-event.ts.</summary>
    public class FileEvent
    {
        public string EventId { get; set; }
        public FileStatus EventType { get; set; }
        public string BatchId { get; set; }
        public string InterfaceId { get; set; }
        /// <summary>Null for FILE_MISSING_BY_SLA (absence-driven, no file).</summary>
        public string FilePath { get; set; }
        public DateTime OccurredAt { get; set; }
    }

    /// <summary>Port of the WatcherState snapshot (current + previous, not a history log).</summary>
    public class WatcherState
    {
        public string InterfaceId { get; set; }
        public string FilePath { get; set; }
        public FileStatus CurrentStatus { get; set; }
        public FileStatus? PreviousStatus { get; set; }
        public string BatchId { get; set; }
        public DateTime FirstDetectedAt { get; set; }
        public DateTime StatusChangedAt { get; set; }
        public DateTime LastSeenAt { get; set; }
        public string FileName { get; set; }
        public long FileSizeBytes { get; set; }
    }

    /// <summary>
    /// Port of packages/contracts config/interface-config.ts. Hydrated from an
    /// fwm_interface row by the plugin. StuckThresholdSeconds and SlaDeadline are
    /// real per-interface columns in Dataverse (the TS EngineDefaults workaround
    /// is retired — deliberate, documented divergence).
    /// </summary>
    public class InterfaceConfig
    {
        public string InterfaceId { get; set; }
        public string InterfaceName { get; set; }
        public string SourceSystem { get; set; }
        public string TargetSystem { get; set; }
        public string ConnectionRef { get; set; }
        public string InboundPath { get; set; }
        public string FilePattern { get; set; }
        public int PollIntervalSeconds { get; set; }
        public string ReadinessRule { get; set; }
        public int StabilityCheckSeconds { get; set; }
        public bool DuplicateCheckEnabled { get; set; }
        public bool EnabledFlag { get; set; }
        public string AlertOwner { get; set; }
        public int StuckThresholdSeconds { get; set; }
        /// <summary>"HH:mm" 24-hour UTC daily arrival deadline (not local time).</summary>
        public string SlaDeadline { get; set; }
    }

    /// <summary>Same contract as the TS StateRepository interface.</summary>
    public interface IStateRepository
    {
        /// <returns>The state for (interfaceId, filePath), or null.</returns>
        WatcherState Get(string interfaceId, string filePath);
        void Save(WatcherState state);
        System.Collections.Generic.IReadOnlyList<WatcherState> FindByInterface(string interfaceId);
    }

    public class InvalidStateTransitionException : Exception
    {
        public InvalidStateTransitionException(FileStatus? from, FileStatus to)
            : base("Invalid state transition: " + (from.HasValue ? from.Value.ToString() : "(none)") + " -> " + to)
        {
        }
    }

    public class InterfaceMismatchException : Exception
    {
        public InterfaceMismatchException(string observationPath, string configInterfaceId)
            : base("Observation " + observationPath + " does not belong to interface " + configInterfaceId)
        {
        }
    }
}
