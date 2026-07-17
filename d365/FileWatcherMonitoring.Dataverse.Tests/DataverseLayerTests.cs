using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using FileWatcherMonitoring.Plugins;
using Xunit;

namespace FileWatcherMonitoring.Dataverse.Tests
{
    public static class TestData
    {
        public static readonly DateTime T0 = new DateTime(2026, 7, 17, 6, 0, 0, DateTimeKind.Utc);

        public static void SeedInterface(FakeOrganizationService service, string interfaceId,
            int stabilitySeconds = 30, int stuckSeconds = 3600, string slaDeadline = "08:00")
        {
            var row = new Entity(Schema.InterfaceTable.LogicalName);
            row[Schema.InterfaceTable.InterfaceId] = interfaceId;
            row[Schema.InterfaceTable.Name] = "Test interface " + interfaceId;
            row[Schema.InterfaceTable.InboundPath] = "/in/";
            row[Schema.InterfaceTable.FilePattern] = ".*\\.csv$";
            row[Schema.InterfaceTable.PollIntervalSeconds] = 60;
            row[Schema.InterfaceTable.StabilityCheckSeconds] = stabilitySeconds;
            row[Schema.InterfaceTable.DuplicateCheckEnabled] = true;
            row[Schema.InterfaceTable.StuckThresholdSeconds] = stuckSeconds;
            row[Schema.InterfaceTable.SlaDeadline] = slaDeadline;
            row[Schema.InterfaceTable.Enabled] = true;
            service.Create(row);
        }

        public static Entity Observation(string interfaceId, string path, long size, DateTime mtime)
        {
            var row = new Entity(Schema.FileObservationTable.LogicalName);
            row[Schema.FileObservationTable.InterfaceId] = interfaceId;
            row[Schema.FileObservationTable.FilePath] = path;
            row[Schema.FileObservationTable.FileSizeBytes] = size;
            row[Schema.FileObservationTable.ModifiedAt] = mtime;
            row[Schema.FileObservationTable.ObservedAt] = mtime;
            return row;
        }

        public static WatcherState State(string interfaceId, string path, FileStatus status, DateTime at)
        {
            return new WatcherState
            {
                InterfaceId = interfaceId,
                FilePath = path,
                FileName = path.Split('/').Last(),
                FileSizeBytes = 100,
                BatchId = Guid.NewGuid().ToString(),
                CurrentStatus = status,
                PreviousStatus = null,
                StatusChangedAt = at,
                FirstDetectedAt = at,
                LastSeenAt = at
            };
        }
    }

    public class DataverseStateRepositoryTests
    {
        [Fact]
        public void Get_ReturnsNull_ForUnknownKey()
        {
            var repo = new DataverseStateRepository(new FakeOrganizationService());
            Assert.Null(repo.Get("SA-034", "/in/a.csv"));
        }

        [Fact]
        public void Save_Then_Get_RoundTrips_AllFields_IncludingNullPreviousStatus()
        {
            var repo = new DataverseStateRepository(new FakeOrganizationService());
            var state = TestData.State("SA-034", "/in/a.csv", FileStatus.FILE_DETECTED, TestData.T0);

            repo.Save(state);
            var loaded = repo.Get("SA-034", "/in/a.csv");

            Assert.NotNull(loaded);
            Assert.Equal(FileStatus.FILE_DETECTED, loaded.CurrentStatus);
            Assert.Null(loaded.PreviousStatus);
            Assert.Equal(state.BatchId, loaded.BatchId);
            Assert.Equal("a.csv", loaded.FileName);
            Assert.Equal(100, loaded.FileSizeBytes);
            Assert.Equal(TestData.T0, loaded.FirstDetectedAt);
        }

        [Fact]
        public void Save_SameKey_Updates_InsteadOfDuplicating()
        {
            var service = new FakeOrganizationService();
            var repo = new DataverseStateRepository(service);
            var state = TestData.State("SA-034", "/in/a.csv", FileStatus.FILE_DETECTED, TestData.T0);
            repo.Save(state);

            state.PreviousStatus = FileStatus.FILE_DETECTED;
            state.CurrentStatus = FileStatus.FILE_STABLE;
            repo.Save(state);

            Assert.Single(service.Rows(Schema.FileState.LogicalName));
            var loaded = repo.Get("SA-034", "/in/a.csv");
            Assert.Equal(FileStatus.FILE_STABLE, loaded.CurrentStatus);
            Assert.Equal(FileStatus.FILE_DETECTED, loaded.PreviousStatus);
        }

        [Fact]
        public void FindByInterface_FiltersOtherInterfaces()
        {
            var repo = new DataverseStateRepository(new FakeOrganizationService());
            repo.Save(TestData.State("SA-034", "/in/a.csv", FileStatus.FILE_DETECTED, TestData.T0));
            repo.Save(TestData.State("SA-034", "/in/b.csv", FileStatus.FILE_STABLE, TestData.T0));
            repo.Save(TestData.State("SA-999", "/in/a.csv", FileStatus.FILE_DETECTED, TestData.T0));

            var states = repo.FindByInterface("SA-034");
            Assert.Equal(2, states.Count);
            Assert.All(states, s => Assert.Equal("SA-034", s.InterfaceId));
        }

        [Fact]
        public void ChoiceMapping_RoundTrips_EveryStatus()
        {
            var repo = new DataverseStateRepository(new FakeOrganizationService());
            foreach (FileStatus status in Enum.GetValues(typeof(FileStatus)))
            {
                var path = "/in/" + status + ".csv";
                repo.Save(TestData.State("SA-034", path, status, TestData.T0));
                Assert.Equal(status, repo.Get("SA-034", path).CurrentStatus);
            }
        }
    }

    public class ObservationProcessorTests
    {
        [Fact]
        public void NewFile_CreatesState_AndEvent_SameBatchId()
        {
            var service = new FakeOrganizationService();
            TestData.SeedInterface(service, "SA-034");

            var fileEvent = ObservationProcessor.Process(
                service, TestData.Observation("SA-034", "/in/a.csv", 100, TestData.T0), TestData.T0);

            Assert.Equal(FileStatus.FILE_DETECTED, fileEvent.EventType);
            var stateRow = Assert.Single(service.Rows(Schema.FileState.LogicalName));
            Assert.Equal("a.csv", stateRow.GetAttributeValue<string>(Schema.FileState.FileName));
            var eventRow = Assert.Single(service.Rows(Schema.FileEventTable.LogicalName));
            Assert.Equal(fileEvent.BatchId, eventRow.GetAttributeValue<string>(Schema.FileEventTable.BatchId));
            Assert.Equal(Schema.ToChoice(FileStatus.FILE_DETECTED),
                eventRow.GetAttributeValue<OptionSetValue>(Schema.FileEventTable.EventType).Value);
        }

        [Fact]
        public void StableAfterWindow_SecondEvent_ReusesBatchId()
        {
            var service = new FakeOrganizationService();
            TestData.SeedInterface(service, "SA-034", stabilitySeconds: 30);

            var first = ObservationProcessor.Process(
                service, TestData.Observation("SA-034", "/in/a.csv", 100, TestData.T0), TestData.T0);
            var second = ObservationProcessor.Process(
                service, TestData.Observation("SA-034", "/in/a.csv", 100, TestData.T0), TestData.T0.AddSeconds(31));

            Assert.Equal(FileStatus.FILE_STABLE, second.EventType);
            Assert.Equal(first.BatchId, second.BatchId);
            Assert.Equal(2, service.Rows(Schema.FileEventTable.LogicalName).Count);
            Assert.Single(service.Rows(Schema.FileState.LogicalName));
        }

        [Fact]
        public void NoMeaningfulChange_ReturnsNull_NoExtraEvent()
        {
            var service = new FakeOrganizationService();
            TestData.SeedInterface(service, "SA-034", stabilitySeconds: 30);

            ObservationProcessor.Process(
                service, TestData.Observation("SA-034", "/in/a.csv", 100, TestData.T0), TestData.T0);
            var second = ObservationProcessor.Process(
                service, TestData.Observation("SA-034", "/in/a.csv", 100, TestData.T0), TestData.T0.AddSeconds(10));

            Assert.Null(second);
            Assert.Single(service.Rows(Schema.FileEventTable.LogicalName));
        }

        [Fact]
        public void MissingInterfaceConfig_Throws()
        {
            var service = new FakeOrganizationService();
            Assert.Throws<InvalidPluginExecutionException>(() => ObservationProcessor.Process(
                service, TestData.Observation("SA-404", "/in/a.csv", 100, TestData.T0), TestData.T0));
        }
    }

    public class SweepProcessorTests
    {
        [Fact]
        public void BeforeDeadline_NoEvents()
        {
            var service = new FakeOrganizationService();
            TestData.SeedInterface(service, "SA-034", slaDeadline: "08:00");

            var count = SweepProcessor.Run(service, "SA-034", TestData.T0); // 06:00 < 08:00
            Assert.Equal(0, count);
            Assert.Empty(service.Rows(Schema.FileEventTable.LogicalName));
        }

        [Fact]
        public void AfterDeadline_NothingArrived_OneEvent_WithNullFilePath_AndSentinel()
        {
            var service = new FakeOrganizationService();
            TestData.SeedInterface(service, "SA-034", slaDeadline: "08:00");

            var count = SweepProcessor.Run(service, "SA-034", TestData.T0.AddHours(3)); // 09:00

            Assert.Equal(1, count);
            var eventRow = Assert.Single(service.Rows(Schema.FileEventTable.LogicalName));
            Assert.Null(eventRow.GetAttributeValue<string>(Schema.FileEventTable.FilePath));
            var sentinel = Assert.Single(service.Rows(Schema.FileState.LogicalName));
            Assert.Equal("__sla_window__", sentinel.GetAttributeValue<string>(Schema.FileState.FilePath));
        }

        [Fact]
        public void SecondSweep_SameDay_Idempotent()
        {
            var service = new FakeOrganizationService();
            TestData.SeedInterface(service, "SA-034", slaDeadline: "08:00");

            Assert.Equal(1, SweepProcessor.Run(service, "SA-034", TestData.T0.AddHours(3)));
            Assert.Equal(0, SweepProcessor.Run(service, "SA-034", TestData.T0.AddHours(4)));
            Assert.Single(service.Rows(Schema.FileEventTable.LogicalName));
        }
    }
}
