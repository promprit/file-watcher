using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using FileWatcherMonitoring.Plugins;
using Xunit;

namespace FileWatcherMonitoring.Plugins.Tests
{
    // ------------------------------------------------------------------ DTOs --

    public class VectorFile
    {
        public List<PolicyCase> Policy { get; set; }
        public List<RuleCase> Rules { get; set; }
        public List<MatcherCase> InterfaceMatcher { get; set; }
        public List<EngineScenario> EngineScenarios { get; set; }
        public List<SweepScenario> SweepScenarios { get; set; }
    }

    public class PolicyCase
    {
        public FileStatus? From { get; set; }
        public FileStatus To { get; set; }
        public bool Allowed { get; set; }
    }

    public class RuleCase
    {
        public string Rule { get; set; }
        public string MatrixRef { get; set; }
        public FileObservation Observation { get; set; }
        public WatcherState State { get; set; }
        public InterfaceConfig Config { get; set; }
        public DateTime Now { get; set; }
        public FileStatus? ExpectedStatus { get; set; }
    }

    public class MatcherCase
    {
        public string MatrixRef { get; set; }
        public string ObservationInterfaceId { get; set; }
        public string ConfigInterfaceId { get; set; }
        public bool Throws { get; set; }
    }

    public class EngineScenario
    {
        public string MatrixRef { get; set; }
        public InterfaceConfig Config { get; set; }
        public List<EngineStep> Steps { get; set; }
    }

    public class EngineStep
    {
        public FileObservation Observation { get; set; }
        public DateTime Now { get; set; }
        public EngineExpect Expect { get; set; }
    }

    public class EngineExpect
    {
        public FileStatus? EventType { get; set; }
        public string Throws { get; set; }
        public ExpectedState StateAfter { get; set; }
        public int? BatchIdSameAsStep { get; set; }
    }

    public class ExpectedState
    {
        public FileStatus CurrentStatus { get; set; }
        public FileStatus? PreviousStatus { get; set; }
        public string FileName { get; set; }
    }

    public class SweepScenario
    {
        public string MatrixRef { get; set; }
        public InterfaceConfig Config { get; set; }
        public List<WatcherState> SeedStates { get; set; }
        public List<SweepStep> Steps { get; set; }
    }

    public class SweepStep
    {
        public DateTime Now { get; set; }
        public int ExpectEventCount { get; set; }
    }

    // ----------------------------------------------------------------- Tests --

    public class VectorParityTests
    {
        private static readonly VectorFile Vectors = Load();

        private static VectorFile Load()
        {
            var path = Path.Combine(AppContext.BaseDirectory, "engine-test-vectors.json");
            var options = new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                Converters = { new JsonStringEnumConverter() }
            };
            return JsonSerializer.Deserialize<VectorFile>(File.ReadAllText(path), options);
        }

        public static IEnumerable<object[]> PolicyIndexes()
        {
            for (var i = 0; i < Vectors.Policy.Count; i++)
            {
                var c = Vectors.Policy[i];
                yield return new object[] { i, (c.From.HasValue ? c.From.Value.ToString() : "(none)") + " -> " + c.To };
            }
        }

        [Theory]
        [MemberData(nameof(PolicyIndexes))]
        public void Policy_MatchesReferenceEngine(int index, string label)
        {
            var c = Vectors.Policy[index];
            if (c.Allowed)
            {
                StateTransitionPolicy.AssertValidTransition(c.From, c.To); // must not throw
            }
            else
            {
                Assert.Throws<InvalidStateTransitionException>(
                    () => StateTransitionPolicy.AssertValidTransition(c.From, c.To));
            }
            Assert.False(string.IsNullOrEmpty(label));
        }

        public static IEnumerable<object[]> RuleIndexes()
        {
            for (var i = 0; i < Vectors.Rules.Count; i++)
            {
                yield return new object[] { i, Vectors.Rules[i].MatrixRef };
            }
        }

        [Theory]
        [MemberData(nameof(RuleIndexes))]
        public void Rules_MatchReferenceEngine(int index, string matrixRef)
        {
            var c = Vectors.Rules[index];
            IRule rule;
            switch (c.Rule)
            {
                case "duplicate": rule = new DuplicateRule(); break;
                case "stuckFile": rule = new StuckFileRule(); break;
                case "stability": rule = new StabilityRule(); break;
                default: throw new InvalidOperationException("unknown rule " + c.Rule + " in " + matrixRef);
            }
            var actual = rule.Evaluate(c.Observation, c.State, c.Config, c.Now);
            Assert.Equal(c.ExpectedStatus, actual);
        }

        public static IEnumerable<object[]> MatcherIndexes()
        {
            for (var i = 0; i < Vectors.InterfaceMatcher.Count; i++)
            {
                yield return new object[] { i, Vectors.InterfaceMatcher[i].MatrixRef };
            }
        }

        [Theory]
        [MemberData(nameof(MatcherIndexes))]
        public void InterfaceMatcher_MatchesReferenceEngine(int index, string matrixRef)
        {
            var c = Vectors.InterfaceMatcher[index];
            var observation = new FileObservation { InterfaceId = c.ObservationInterfaceId, Path = "/in/a.csv", Size = 1, Mtime = DateTime.UtcNow };
            var config = new InterfaceConfig { InterfaceId = c.ConfigInterfaceId };
            if (c.Throws)
            {
                Assert.Throws<InterfaceMismatchException>(() => InterfaceMatcher.AssertMatch(observation, config));
            }
            else
            {
                InterfaceMatcher.AssertMatch(observation, config); // must not throw
            }
            Assert.False(string.IsNullOrEmpty(matrixRef));
        }

        public static IEnumerable<object[]> EngineIndexes()
        {
            for (var i = 0; i < Vectors.EngineScenarios.Count; i++)
            {
                yield return new object[] { i, Vectors.EngineScenarios[i].MatrixRef };
            }
        }

        [Theory]
        [MemberData(nameof(EngineIndexes))]
        public void EngineScenarios_MatchReferenceEngine(int index, string matrixRef)
        {
            var scenario = Vectors.EngineScenarios[index];
            var repo = new InMemoryStateRepository();
            var engine = new WatcherEngine(repo);
            var batchIds = new List<string>();

            for (var i = 0; i < scenario.Steps.Count; i++)
            {
                var step = scenario.Steps[i];
                FileEvent fileEvent = null;
                string threw = null;
                try
                {
                    fileEvent = engine.ProcessObservation(step.Observation, scenario.Config, step.Now);
                }
                catch (InterfaceMismatchException) { threw = "InterfaceMismatchError"; }
                catch (InvalidStateTransitionException) { threw = "InvalidStateTransitionError"; }

                batchIds.Add(fileEvent != null ? fileEvent.BatchId : null);

                Assert.Equal(step.Expect.Throws, threw);
                Assert.Equal(step.Expect.EventType, fileEvent != null ? fileEvent.EventType : (FileStatus?)null);

                if (step.Expect.StateAfter != null)
                {
                    var state = repo.Get(step.Observation.InterfaceId, step.Observation.Path);
                    Assert.NotNull(state);
                    Assert.Equal(step.Expect.StateAfter.CurrentStatus, state.CurrentStatus);
                    Assert.Equal(step.Expect.StateAfter.PreviousStatus, state.PreviousStatus);
                    Assert.Equal(step.Expect.StateAfter.FileName, state.FileName);
                }

                if (step.Expect.BatchIdSameAsStep.HasValue)
                {
                    Assert.NotNull(fileEvent);
                    Assert.Equal(batchIds[step.Expect.BatchIdSameAsStep.Value], fileEvent.BatchId);
                }
            }
            Assert.False(string.IsNullOrEmpty(matrixRef));
        }

        public static IEnumerable<object[]> SweepIndexes()
        {
            for (var i = 0; i < Vectors.SweepScenarios.Count; i++)
            {
                yield return new object[] { i, Vectors.SweepScenarios[i].MatrixRef };
            }
        }

        [Theory]
        [MemberData(nameof(SweepIndexes))]
        public void SweepScenarios_MatchReferenceEngine(int index, string matrixRef)
        {
            var scenario = Vectors.SweepScenarios[index];
            var repo = new InMemoryStateRepository();
            foreach (var seed in scenario.SeedStates)
            {
                repo.Save(seed);
            }
            var sweep = new MissingSlaSweep(repo);

            foreach (var step in scenario.Steps)
            {
                var events = sweep.CheckMissingSla(scenario.Config, step.Now);
                Assert.Equal(step.ExpectEventCount, events.Length);
                foreach (var ev in events)
                {
                    Assert.Equal(FileStatus.FILE_MISSING_BY_SLA, ev.EventType);
                    Assert.Null(ev.FilePath);
                    Assert.False(string.IsNullOrEmpty(ev.BatchId));
                    Assert.False(string.IsNullOrEmpty(ev.EventId));
                }
            }
            Assert.False(string.IsNullOrEmpty(matrixRef));
        }
    }

    /// <summary>
    /// Property-based cases the JSON vectors cannot carry (randomness):
    /// BatchIdGeneratorTests + EventBuilderTests from the parity matrix.
    /// </summary>
    public class GeneratorPropertyTests
    {
        [Fact]
        public void BatchId_ReturnsNonEmptyString()
        {
            Assert.False(string.IsNullOrEmpty(BatchIdGenerator.NewBatchId()));
        }

        [Fact]
        public void BatchId_ReturnsDifferentId_EachCall()
        {
            Assert.NotEqual(BatchIdGenerator.NewBatchId(), BatchIdGenerator.NewBatchId());
        }

        [Fact]
        public void EventBuilder_BuildsFileEvent_FromObservationStatusAndBatchId()
        {
            var now = new DateTime(2026, 7, 17, 6, 0, 0, DateTimeKind.Utc);
            var observation = new FileObservation { InterfaceId = "SA-034", Path = "/in/a.csv", Size = 100, Mtime = now };
            var fileEvent = EventBuilder.Build(observation, FileStatus.FILE_STABLE, "batch-1", now);

            Assert.Equal(FileStatus.FILE_STABLE, fileEvent.EventType);
            Assert.Equal("batch-1", fileEvent.BatchId);
            Assert.Equal("SA-034", fileEvent.InterfaceId);
            Assert.Equal("/in/a.csv", fileEvent.FilePath);
            Assert.Equal(now, fileEvent.OccurredAt);
            Assert.False(string.IsNullOrEmpty(fileEvent.EventId));
        }

        [Fact]
        public void EventBuilder_GeneratesFreshEventId_EachCall()
        {
            var now = DateTime.UtcNow;
            var observation = new FileObservation { InterfaceId = "SA-034", Path = "/in/a.csv", Size = 100, Mtime = now };
            var first = EventBuilder.Build(observation, FileStatus.FILE_DETECTED, "b", now);
            var second = EventBuilder.Build(observation, FileStatus.FILE_DETECTED, "b", now);
            Assert.NotEqual(first.EventId, second.EventId);
        }
    }
}
