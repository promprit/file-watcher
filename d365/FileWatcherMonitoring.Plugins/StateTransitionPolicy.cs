using System.Collections.Generic;

namespace FileWatcherMonitoring.Plugins
{
    /// <summary>
    /// Port of engine/state-transition.policy.ts. Allow-list, not deny-list:
    /// any transition not listed is invalid.
    /// </summary>
    public static class StateTransitionPolicy
    {
        private static readonly Dictionary<string, FileStatus[]> ValidTransitions =
            new Dictionary<string, FileStatus[]>
            {
                { None, new[] { FileStatus.FILE_DETECTED, FileStatus.FILE_MISSING_BY_SLA } },
                { nameof(FileStatus.FILE_DETECTED), new[] { FileStatus.FILE_STABLE, FileStatus.FILE_STUCK } },
                { nameof(FileStatus.FILE_STABLE), new[] { FileStatus.FILE_DUPLICATE } },
                { nameof(FileStatus.FILE_STUCK), new[] { FileStatus.FILE_STABLE } },
                { nameof(FileStatus.FILE_DUPLICATE), new FileStatus[0] },
                { nameof(FileStatus.FILE_MISSING_BY_SLA), new[] { FileStatus.FILE_MISSING_BY_SLA } }
            };

        private const string None = "(none)";

        public static void AssertValidTransition(FileStatus? from, FileStatus to)
        {
            var key = from.HasValue ? from.Value.ToString() : None;
            FileStatus[] allowed;
            if (!ValidTransitions.TryGetValue(key, out allowed) || System.Array.IndexOf(allowed, to) < 0)
            {
                throw new InvalidStateTransitionException(from, to);
            }
        }
    }
}
