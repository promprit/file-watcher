using System;
using System.Linq;

namespace FileWatcherMonitoring.Plugins
{
    /// <summary>
    /// Port of engine/missing-sla-sweep.ts checkMissingSla(). Absence-driven,
    /// outside the rule pipeline. slaDeadline is "HH:mm" UTC (not local time) —
    /// all day/deadline math is UTC-based, exactly like the TS reference.
    /// Idempotent per UTC day via the sentinel row (__sla_window__).
    /// </summary>
    public class MissingSlaSweep
    {
        public const string SlaSentinelPath = "__sla_window__";

        private readonly IStateRepository _stateRepo;

        public MissingSlaSweep(IStateRepository stateRepo)
        {
            _stateRepo = stateRepo;
        }

        public FileEvent[] CheckMissingSla(InterfaceConfig interfaceConfig, DateTime now)
        {
            var deadline = TodaysDeadline(interfaceConfig.SlaDeadline, now);
            if (now < deadline)
            {
                return new FileEvent[0];
            }

            var states = _stateRepo.FindByInterface(interfaceConfig.InterfaceId);
            var arrivedToday = states.Any(s => s.FilePath != SlaSentinelPath && IsSameUtcDay(s.FirstDetectedAt, now));
            if (arrivedToday)
            {
                return new FileEvent[0];
            }

            var existingSentinel = _stateRepo.Get(interfaceConfig.InterfaceId, SlaSentinelPath);
            if (existingSentinel != null
                && existingSentinel.CurrentStatus == FileStatus.FILE_MISSING_BY_SLA
                && IsSameUtcDay(existingSentinel.StatusChangedAt, now))
            {
                return new FileEvent[0];
            }

            FileStatus? currentSentinelStatus = existingSentinel != null
                ? existingSentinel.CurrentStatus
                : (FileStatus?)null;
            StateTransitionPolicy.AssertValidTransition(currentSentinelStatus, FileStatus.FILE_MISSING_BY_SLA);

            var batchId = BatchIdGenerator.NewBatchId();
            var newState = new WatcherState
            {
                InterfaceId = interfaceConfig.InterfaceId,
                FilePath = SlaSentinelPath,
                CurrentStatus = FileStatus.FILE_MISSING_BY_SLA,
                PreviousStatus = currentSentinelStatus,
                BatchId = batchId,
                FirstDetectedAt = now,
                StatusChangedAt = now,
                LastSeenAt = now,
                FileName = SlaSentinelPath,
                FileSizeBytes = 0
            };
            _stateRepo.Save(newState);

            var fileEvent = new FileEvent
            {
                EventId = Guid.NewGuid().ToString(),
                EventType = FileStatus.FILE_MISSING_BY_SLA,
                BatchId = batchId,
                InterfaceId = interfaceConfig.InterfaceId,
                FilePath = null,
                OccurredAt = now
            };

            return new[] { fileEvent };
        }

        private static bool IsSameUtcDay(DateTime a, DateTime b)
        {
            return a.Year == b.Year && a.Month == b.Month && a.Day == b.Day;
        }

        private static DateTime TodaysDeadline(string slaDeadline, DateTime now)
        {
            var parts = slaDeadline.Split(':');
            var hours = int.Parse(parts[0]);
            var minutes = int.Parse(parts[1]);
            return new DateTime(now.Year, now.Month, now.Day, hours, minutes, 0, DateTimeKind.Utc);
        }
    }
}
