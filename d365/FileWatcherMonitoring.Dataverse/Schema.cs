using System.Collections.Generic;
using FileWatcherMonitoring.Plugins;

namespace FileWatcherMonitoring.Dataverse
{
    /// <summary>
    /// Single place for Dataverse logical names and choice values, mirroring the
    /// data model in docs/superpowers/specs/2026-07-17-d365-native-architecture-design.md.
    /// The engine keys states/config off the business interface id (e.g. "SA-034")
    /// stored as a text column; the fwm_interface lookup can coexist for UI purposes.
    /// </summary>
    public static class Schema
    {
        public static class FileState
        {
            public const string LogicalName = "fwm_filestate";
            public const string InterfaceId = "fwm_interfaceid";
            public const string FilePath = "fwm_filepath";
            public const string FileName = "fwm_filename";
            public const string FileSizeBytes = "fwm_filesizebytes";
            public const string BatchId = "fwm_batchid";
            public const string CurrentStatus = "fwm_currentstatus";
            public const string PreviousStatus = "fwm_previousstatus";
            public const string StatusChangedAt = "fwm_statuschangedat";
            public const string FirstDetectedAt = "fwm_firstdetectedat";
            public const string LastSeenAt = "fwm_lastseenat";
        }

        public static class FileEventTable
        {
            public const string LogicalName = "fwm_fileevent";
            public const string EventId = "fwm_eventid";
            public const string EventType = "fwm_eventtype";
            public const string BatchId = "fwm_batchid";
            public const string InterfaceId = "fwm_interfaceid";
            public const string FilePath = "fwm_filepath";
            public const string OccurredAt = "fwm_occurredat";
        }

        public static class FileObservationTable
        {
            public const string LogicalName = "fwm_fileobservation";
            public const string InterfaceId = "fwm_interfaceid";
            public const string FilePath = "fwm_filepath";
            public const string FileSizeBytes = "fwm_filesizebytes";
            public const string ModifiedAt = "fwm_modifiedat";
            public const string ObservedAt = "fwm_observedat";
        }

        public static class InterfaceTable
        {
            public const string LogicalName = "fwm_interface";
            public const string InterfaceId = "fwm_interfaceid";
            public const string Name = "fwm_name";
            public const string InboundPath = "fwm_inboundpath";
            public const string FilePattern = "fwm_filepattern";
            public const string PollIntervalSeconds = "fwm_pollintervalseconds";
            public const string StabilityCheckSeconds = "fwm_stabilitycheckseconds";
            public const string DuplicateCheckEnabled = "fwm_duplicatecheckenabled";
            public const string StuckThresholdSeconds = "fwm_stuckthresholdseconds";
            public const string SlaDeadline = "fwm_sladeadline";
            public const string Enabled = "fwm_enabled";
            public const string InterfaceType = "fwm_interfacetype";
            public const string ProcessingTimeoutSeconds = "fwm_processingtimeoutseconds";
        }

        /// <summary>fwm_interfacetype choice values.</summary>
        public const int InterfaceTypeFile = 100000000;
        public const int InterfaceTypeApi = 100000001;

        public static class ApiMessageTable
        {
            public const string LogicalName = "fwm_apimessage";
            public const string InterfaceId = "fwm_interfaceid";
            public const string MessageId = "fwm_messageid";
            public const string CorrelationId = "fwm_correlationid";
            public const string CurrentStatus = "fwm_currentstatus";
            public const string PreviousStatus = "fwm_previousstatus";
            public const string BatchId = "fwm_batchid";
            public const string ReceivedAt = "fwm_receivedat";
            public const string ProcessedAt = "fwm_processedat";
            public const string ErrorCode = "fwm_errorcode";
            public const string StatusChangedAt = "fwm_statuschangedat";
        }

        public static class ApiEventTable
        {
            public const string LogicalName = "fwm_apievent";
            public const string EventId = "fwm_eventid";
            public const string EventType = "fwm_eventtype";
            public const string BatchId = "fwm_batchid";
            public const string InterfaceId = "fwm_interfaceid";
            public const string MessageId = "fwm_messageid";
            public const string OccurredAt = "fwm_occurredat";
        }

        /// <summary>fwm_filestatus global choice — values fixed here, mirrored in the solution.</summary>
        private static readonly Dictionary<FileStatus, int> StatusToChoice = new Dictionary<FileStatus, int>
        {
            { FileStatus.FILE_DETECTED, 100000000 },
            { FileStatus.FILE_STABLE, 100000001 },
            { FileStatus.FILE_DUPLICATE, 100000002 },
            { FileStatus.FILE_STUCK, 100000003 },
            { FileStatus.FILE_MISSING_BY_SLA, 100000004 }
        };

        private static readonly Dictionary<int, FileStatus> ChoiceToStatus = Invert(StatusToChoice);

        private static Dictionary<int, FileStatus> Invert(Dictionary<FileStatus, int> map)
        {
            var result = new Dictionary<int, FileStatus>();
            foreach (var pair in map)
            {
                result[pair.Value] = pair.Key;
            }
            return result;
        }

        public static int ToChoice(FileStatus status)
        {
            return StatusToChoice[status];
        }

        public static FileStatus FromChoice(int value)
        {
            return ChoiceToStatus[value];
        }

        /// <summary>fwm_apistatus global choice — values fixed here, mirrored in the solution.</summary>
        private static readonly Dictionary<ApiStatus, int> ApiStatusToChoice = new Dictionary<ApiStatus, int>
        {
            { ApiStatus.MSG_RECEIVED, 100000000 },
            { ApiStatus.MSG_PROCESSED, 100000001 },
            { ApiStatus.MSG_DUPLICATE, 100000002 },
            { ApiStatus.MSG_FAILED, 100000003 },
            { ApiStatus.MSG_TIMEOUT, 100000004 },
            { ApiStatus.FEED_MISSING_BY_SLA, 100000005 }
        };

        private static readonly Dictionary<int, ApiStatus> ChoiceToApiStatus = InvertApi(ApiStatusToChoice);

        private static Dictionary<int, ApiStatus> InvertApi(Dictionary<ApiStatus, int> map)
        {
            var result = new Dictionary<int, ApiStatus>();
            foreach (var pair in map)
            {
                result[pair.Value] = pair.Key;
            }
            return result;
        }

        public static int ToChoice(ApiStatus status)
        {
            return ApiStatusToChoice[status];
        }

        public static ApiStatus ApiFromChoice(int value)
        {
            return ChoiceToApiStatus[value];
        }
    }
}
