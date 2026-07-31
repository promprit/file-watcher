using System.Collections.Generic;
using System.Linq;
using FileWatcherMonitoring.Plugins;

namespace FileWatcherMonitoring.Plugins.Tests
{
    /// <summary>
    /// Port of engine/state/in-memory-state-repository.ts — the test double the
    /// reference suite uses. In the client environment, FakeXrmEasy plus
    /// DataverseStateRepository replace this for plugin-level tests.
    /// </summary>
    public class InMemoryStateRepository : IStateRepository
    {
        private readonly Dictionary<string, WatcherState> _store = new Dictionary<string, WatcherState>();

        private static string Key(string interfaceId, string filePath)
        {
            return interfaceId + "::" + filePath;
        }

        public WatcherState Get(string interfaceId, string filePath)
        {
            WatcherState state;
            return _store.TryGetValue(Key(interfaceId, filePath), out state) ? state : null;
        }

        public void Save(WatcherState state)
        {
            _store[Key(state.InterfaceId, state.FilePath)] = state;
        }

        public IReadOnlyList<WatcherState> FindByInterface(string interfaceId)
        {
            return _store.Values.Where(s => s.InterfaceId == interfaceId).ToList();
        }
    }
}
