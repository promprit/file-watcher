using System;
using System.Linq;
using Microsoft.Xrm.Sdk;
using FileWatcherMonitoring.Plugins;
using Xunit;

namespace FileWatcherMonitoring.Dataverse.Tests
{
    public static class ApiTestData
    {
        public static readonly DateTime T0 = new DateTime(2026, 7, 22, 6, 0, 0, DateTimeKind.Utc);

        public static FakeOrganizationService ServiceWithInterface(
            int processingTimeoutSeconds = 300, string slaDeadline = "08:00")
        {
            var service = new FakeOrganizationService();
            var row = new Entity(Schema.InterfaceTable.LogicalName);
            row[Schema.InterfaceTable.InterfaceId] = "API-001";
            row[Schema.InterfaceTable.Name] = "Test API interface";
            row[Schema.InterfaceTable.InterfaceType] = new OptionSetValue(Schema.InterfaceTypeApi);
            row[Schema.InterfaceTable.ProcessingTimeoutSeconds] = processingTimeoutSeconds;
            row[Schema.InterfaceTable.SlaDeadline] = slaDeadline;
            row[Schema.InterfaceTable.Enabled] = true;
            // Columns the shared ConfigLoader also hydrates for file interfaces:
            row[Schema.InterfaceTable.PollIntervalSeconds] = 60;
            row[Schema.InterfaceTable.StabilityCheckSeconds] = 30;
            row[Schema.InterfaceTable.DuplicateCheckEnabled] = true;
            row[Schema.InterfaceTable.StuckThresholdSeconds] = 3600;
            row[Schema.InterfaceTable.InboundPath] = "/";
            row[Schema.InterfaceTable.FilePattern] = ".*";
            service.Create(row);
            return service;
        }

        public static ApiStatus? StatusOf(FakeOrganizationService service, string messageId)
        {
            var row = service.Rows(Schema.ApiMessageTable.LogicalName)
                .FirstOrDefault(r => r.GetAttributeValue<string>(Schema.ApiMessageTable.MessageId) == messageId);
            return row == null
                ? (ApiStatus?)null
                : Schema.ApiFromChoice(row.GetAttributeValue<OptionSetValue>(Schema.ApiMessageTable.CurrentStatus).Value);
        }
    }

    public class ApiTransitionPolicyTests
    {
        [Theory]
        [InlineData(null, ApiStatus.MSG_RECEIVED)]
        [InlineData(null, ApiStatus.FEED_MISSING_BY_SLA)]
        [InlineData(ApiStatus.MSG_RECEIVED, ApiStatus.MSG_PROCESSED)]
        [InlineData(ApiStatus.MSG_RECEIVED, ApiStatus.MSG_FAILED)]
        [InlineData(ApiStatus.MSG_RECEIVED, ApiStatus.MSG_TIMEOUT)]
        [InlineData(ApiStatus.MSG_TIMEOUT, ApiStatus.MSG_PROCESSED)]
        [InlineData(ApiStatus.MSG_TIMEOUT, ApiStatus.MSG_FAILED)]
        [InlineData(ApiStatus.MSG_PROCESSED, ApiStatus.MSG_DUPLICATE)]
        [InlineData(ApiStatus.MSG_FAILED, ApiStatus.MSG_DUPLICATE)]
        [InlineData(ApiStatus.FEED_MISSING_BY_SLA, ApiStatus.FEED_MISSING_BY_SLA)]
        public void Allows(ApiStatus? from, ApiStatus to)
        {
            ApiTransitionPolicy.AssertValidTransition(from, to);
        }

        [Theory]
        [InlineData(ApiStatus.MSG_PROCESSED, ApiStatus.MSG_RECEIVED)]
        [InlineData(ApiStatus.MSG_DUPLICATE, ApiStatus.MSG_PROCESSED)]
        [InlineData(ApiStatus.MSG_FAILED, ApiStatus.MSG_PROCESSED)]
        [InlineData(null, ApiStatus.MSG_PROCESSED)]
        [InlineData(null, ApiStatus.MSG_TIMEOUT)]
        [InlineData(ApiStatus.MSG_RECEIVED, ApiStatus.MSG_DUPLICATE)]
        public void Rejects(ApiStatus? from, ApiStatus to)
        {
            Assert.Throws<InvalidApiTransitionException>(() => ApiTransitionPolicy.AssertValidTransition(from, to));
        }
    }

    public class ApiReportTests
    {
        [Fact]
        public void Received_NewMessage_CreatesStateAndEvent()
        {
            var service = ApiTestData.ServiceWithInterface();
            var status = ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Received, "corr-9", null, ApiTestData.T0);

            Assert.Equal(ApiStatus.MSG_RECEIVED, status);
            Assert.Equal(ApiStatus.MSG_RECEIVED, ApiTestData.StatusOf(service, "m-1"));
            var eventRow = Assert.Single(service.Rows(Schema.ApiEventTable.LogicalName));
            Assert.Equal(Schema.ToChoice(ApiStatus.MSG_RECEIVED),
                eventRow.GetAttributeValue<OptionSetValue>(Schema.ApiEventTable.EventType).Value);
        }

        [Fact]
        public void Processed_AfterReceived_SetsProcessedAt_SameBatch()
        {
            var service = ApiTestData.ServiceWithInterface();
            ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Received, null, null, ApiTestData.T0);
            var status = ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Processed, null, null, ApiTestData.T0.AddSeconds(30));

            Assert.Equal(ApiStatus.MSG_PROCESSED, status);
            var events = service.Rows(Schema.ApiEventTable.LogicalName);
            Assert.Equal(2, events.Count);
            Assert.Equal(events[0].GetAttributeValue<string>(Schema.ApiEventTable.BatchId),
                         events[1].GetAttributeValue<string>(Schema.ApiEventTable.BatchId));
        }

        [Fact]
        public void Received_AfterTerminal_FlagsDuplicate()
        {
            var service = ApiTestData.ServiceWithInterface();
            ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Received, null, null, ApiTestData.T0);
            ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Processed, null, null, ApiTestData.T0.AddSeconds(1));
            var status = ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Received, null, null, ApiTestData.T0.AddSeconds(2));

            Assert.Equal(ApiStatus.MSG_DUPLICATE, status);
            Assert.Equal(3, service.Rows(Schema.ApiEventTable.LogicalName).Count);
        }

        [Fact]
        public void Received_WhileInFlight_IsNoOp()
        {
            var service = ApiTestData.ServiceWithInterface();
            ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Received, null, null, ApiTestData.T0);
            var status = ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Received, null, null, ApiTestData.T0.AddSeconds(5));

            Assert.Null(status);
            Assert.Single(service.Rows(Schema.ApiEventTable.LogicalName));
        }

        [Fact]
        public void Failed_RecordsErrorCode()
        {
            var service = ApiTestData.ServiceWithInterface();
            ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Received, null, null, ApiTestData.T0);
            var status = ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Failed, null, "E42", ApiTestData.T0.AddSeconds(9));

            Assert.Equal(ApiStatus.MSG_FAILED, status);
            var row = service.Rows(Schema.ApiMessageTable.LogicalName).Single();
            Assert.Equal("E42", row.GetAttributeValue<string>(Schema.ApiMessageTable.ErrorCode));
        }

        [Fact]
        public void ProcessedReport_ForUnknownMessage_Throws()
        {
            var service = ApiTestData.ServiceWithInterface();
            Assert.Throws<UnknownApiMessageException>(() =>
                ApiMessageProcessor.Report(service, "API-001", "ghost", ApiReportAction.Processed, null, null, ApiTestData.T0));
        }
    }

    public class ApiSlaTests
    {
        [Fact]
        public void InFlightMessage_PastTimeout_BecomesTimeout_ThenLateProcessedRecovers()
        {
            var service = ApiTestData.ServiceWithInterface(processingTimeoutSeconds: 300, slaDeadline: "23:59");
            ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Received, null, null, ApiTestData.T0);

            var count = ApiMessageProcessor.CheckSla(service, "API-001", ApiTestData.T0.AddSeconds(301));
            Assert.Equal(1, count);
            Assert.Equal(ApiStatus.MSG_TIMEOUT, ApiTestData.StatusOf(service, "m-1"));

            var late = ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Processed, null, null, ApiTestData.T0.AddSeconds(400));
            Assert.Equal(ApiStatus.MSG_PROCESSED, late);
        }

        [Fact]
        public void Timeout_NotReemitted_OnSecondSweep()
        {
            var service = ApiTestData.ServiceWithInterface(processingTimeoutSeconds: 300, slaDeadline: "23:59");
            ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Received, null, null, ApiTestData.T0);
            ApiMessageProcessor.CheckSla(service, "API-001", ApiTestData.T0.AddSeconds(301));

            var second = ApiMessageProcessor.CheckSla(service, "API-001", ApiTestData.T0.AddSeconds(600));
            Assert.Equal(0, second);
        }

        [Fact]
        public void Heartbeat_SilentFeedPastDeadline_OneEvent_IdempotentSameDay_ReemitsNextDay()
        {
            var service = ApiTestData.ServiceWithInterface(processingTimeoutSeconds: 0, slaDeadline: "08:00");

            Assert.Equal(0, ApiMessageProcessor.CheckSla(service, "API-001", ApiTestData.T0));            // 06:00 — before deadline
            Assert.Equal(1, ApiMessageProcessor.CheckSla(service, "API-001", ApiTestData.T0.AddHours(3))); // 09:00 — silent
            Assert.Equal(0, ApiMessageProcessor.CheckSla(service, "API-001", ApiTestData.T0.AddHours(4))); // same day — sentinel
            Assert.Equal(1, ApiMessageProcessor.CheckSla(service, "API-001", ApiTestData.T0.AddDays(1).AddHours(3))); // next day
        }

        [Fact]
        public void Heartbeat_QuietWhenMessageArrivedToday()
        {
            var service = ApiTestData.ServiceWithInterface(processingTimeoutSeconds: 0, slaDeadline: "08:00");
            ApiMessageProcessor.Report(service, "API-001", "m-1", ApiReportAction.Received, null, null, ApiTestData.T0); // 06:00 today

            Assert.Equal(0, ApiMessageProcessor.CheckSla(service, "API-001", ApiTestData.T0.AddHours(3)));
        }
    }
}
