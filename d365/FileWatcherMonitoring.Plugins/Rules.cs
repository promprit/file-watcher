using System;

namespace FileWatcherMonitoring.Plugins
{
    /// <summary>Port of engine/rules/rule.ts. Null result = rule does not fire.</summary>
    public interface IRule
    {
        FileStatus? Evaluate(FileObservation observation, WatcherState state, InterfaceConfig config, DateTime now);
    }

    internal static class RuleShared
    {
        public static bool IsTerminal(FileStatus status)
        {
            return status == FileStatus.FILE_STABLE || status == FileStatus.FILE_DUPLICATE;
        }
    }

    /// <summary>Port of duplicate.rule.ts: prior terminal status + same path → FILE_DUPLICATE.</summary>
    public class DuplicateRule : IRule
    {
        public FileStatus? Evaluate(FileObservation observation, WatcherState state, InterfaceConfig config, DateTime now)
        {
            if (state == null) return null;
            if (!RuleShared.IsTerminal(state.CurrentStatus)) return null;
            if (state.FilePath != observation.Path) return null;
            return FileStatus.FILE_DUPLICATE;
        }
    }

    /// <summary>Port of stuck-file.rule.ts: non-terminal past stuckThresholdSeconds → FILE_STUCK.</summary>
    public class StuckFileRule : IRule
    {
        public FileStatus? Evaluate(FileObservation observation, WatcherState state, InterfaceConfig config, DateTime now)
        {
            if (state == null) return null;
            if (RuleShared.IsTerminal(state.CurrentStatus)) return null;
            var elapsedSeconds = (now - state.FirstDetectedAt).TotalSeconds;
            if (elapsedSeconds < config.StuckThresholdSeconds) return null;
            return FileStatus.FILE_STUCK;
        }
    }

    /// <summary>Port of stability.rule.ts: FILE_DETECTED + unchanged size past stabilityCheckSeconds → FILE_STABLE.</summary>
    public class StabilityRule : IRule
    {
        public FileStatus? Evaluate(FileObservation observation, WatcherState state, InterfaceConfig config, DateTime now)
        {
            if (state == null) return null;
            if (state.CurrentStatus != FileStatus.FILE_DETECTED) return null;
            if (state.FileSizeBytes != observation.Size) return null;
            var elapsedSeconds = (now - state.StatusChangedAt).TotalSeconds;
            if (elapsedSeconds < config.StabilityCheckSeconds) return null;
            return FileStatus.FILE_STABLE;
        }
    }
}
