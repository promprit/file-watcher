using System;
using System.Collections.Generic;

namespace FileWatcherMonitoring.Plugins
{
    /// <summary>
    /// API entry-point monitoring — the second rule pack on the same engine skeleton.
    /// Files are watched (they can't announce themselves); API messages REPORT
    /// themselves: the integration (or an F&O business-event flow) calls
    /// fwm_ReportApiMessage with Received / Processed / Failed. Same append-only
    /// event log idea, same allow-list discipline, same sentinel-row SLA pattern.
    /// </summary>
    public enum ApiStatus
    {
        MSG_RECEIVED,
        MSG_PROCESSED,
        MSG_DUPLICATE,
        MSG_FAILED,
        MSG_TIMEOUT,
        FEED_MISSING_BY_SLA
    }

    public enum ApiReportAction
    {
        Received,
        Processed,
        Failed
    }

    public class ApiMessageState
    {
        public string InterfaceId { get; set; }
        public string MessageId { get; set; }
        public string CorrelationId { get; set; }
        public ApiStatus CurrentStatus { get; set; }
        public ApiStatus? PreviousStatus { get; set; }
        public string BatchId { get; set; }
        public DateTime ReceivedAt { get; set; }
        public DateTime? ProcessedAt { get; set; }
        public string ErrorCode { get; set; }
        public DateTime StatusChangedAt { get; set; }
    }

    public class InvalidApiTransitionException : Exception
    {
        public InvalidApiTransitionException(ApiStatus? from, ApiStatus to)
            : base("Invalid API message transition: " + (from.HasValue ? from.Value.ToString() : "(none)") + " -> " + to)
        {
        }
    }

    public class UnknownApiMessageException : Exception
    {
        public UnknownApiMessageException(string messageId, ApiReportAction action)
            : base("Report '" + action + "' for unknown message id " + messageId + " — Received must come first")
        {
        }
    }

    /// <summary>Allow-list, mirroring StateTransitionPolicy. Anything unlisted is invalid.</summary>
    public static class ApiTransitionPolicy
    {
        private const string None = "(none)";

        private static readonly Dictionary<string, ApiStatus[]> ValidTransitions =
            new Dictionary<string, ApiStatus[]>
            {
                { None, new[] { ApiStatus.MSG_RECEIVED, ApiStatus.FEED_MISSING_BY_SLA } },
                { nameof(ApiStatus.MSG_RECEIVED), new[] { ApiStatus.MSG_PROCESSED, ApiStatus.MSG_FAILED, ApiStatus.MSG_TIMEOUT } },
                // Late completion / late failure after a timeout is real and must be recordable.
                { nameof(ApiStatus.MSG_TIMEOUT), new[] { ApiStatus.MSG_PROCESSED, ApiStatus.MSG_FAILED } },
                // Terminal statuses may only be re-flagged as duplicates on a re-report.
                { nameof(ApiStatus.MSG_PROCESSED), new[] { ApiStatus.MSG_DUPLICATE } },
                { nameof(ApiStatus.MSG_FAILED), new[] { ApiStatus.MSG_DUPLICATE } },
                { nameof(ApiStatus.MSG_DUPLICATE), new ApiStatus[0] },
                { nameof(ApiStatus.FEED_MISSING_BY_SLA), new[] { ApiStatus.FEED_MISSING_BY_SLA } }
            };

        public static void AssertValidTransition(ApiStatus? from, ApiStatus to)
        {
            var key = from.HasValue ? from.Value.ToString() : None;
            ApiStatus[] allowed;
            if (!ValidTransitions.TryGetValue(key, out allowed) || Array.IndexOf(allowed, to) < 0)
            {
                throw new InvalidApiTransitionException(from, to);
            }
        }
    }

    /// <summary>
    /// Decides what a report means given existing state. Pure logic — persistence is
    /// the caller's job (mirrors WatcherEngine's shape). Returns the new state to
    /// save, or null when the report changes nothing meaningful.
    /// </summary>
    public class ApiMessageEngine
    {
        public ApiMessageState Decide(ApiReportAction action, string interfaceId, string messageId,
            string correlationId, string errorCode, ApiMessageState existing, DateTime now)
        {
            ApiStatus proposed;
            if (action == ApiReportAction.Received)
            {
                if (existing == null)
                {
                    proposed = ApiStatus.MSG_RECEIVED;
                }
                else if (existing.CurrentStatus == ApiStatus.MSG_DUPLICATE)
                {
                    return null; // already flagged; further re-sends are noise
                }
                else if (existing.CurrentStatus == ApiStatus.MSG_PROCESSED || existing.CurrentStatus == ApiStatus.MSG_FAILED)
                {
                    proposed = ApiStatus.MSG_DUPLICATE;
                }
                else
                {
                    return null; // re-received while still in flight — no meaningful change
                }
            }
            else
            {
                if (existing == null)
                {
                    throw new UnknownApiMessageException(messageId, action);
                }
                proposed = action == ApiReportAction.Processed ? ApiStatus.MSG_PROCESSED : ApiStatus.MSG_FAILED;
                if (existing.CurrentStatus == proposed)
                {
                    return null; // idempotent re-report
                }
            }

            var currentStatus = existing != null ? existing.CurrentStatus : (ApiStatus?)null;
            ApiTransitionPolicy.AssertValidTransition(currentStatus, proposed);

            return new ApiMessageState
            {
                InterfaceId = interfaceId,
                MessageId = messageId,
                CorrelationId = existing != null ? existing.CorrelationId : correlationId,
                CurrentStatus = proposed,
                PreviousStatus = currentStatus,
                BatchId = existing != null ? existing.BatchId : Guid.NewGuid().ToString(),
                ReceivedAt = existing != null ? existing.ReceivedAt : now,
                ProcessedAt = proposed == ApiStatus.MSG_PROCESSED ? now : existing != null ? existing.ProcessedAt : (DateTime?)null,
                ErrorCode = proposed == ApiStatus.MSG_FAILED ? errorCode : existing != null ? existing.ErrorCode : null,
                StatusChangedAt = now
            };
        }

        /// <summary>In-flight past the interface's processing timeout → MSG_TIMEOUT.</summary>
        public static bool IsTimedOut(ApiMessageState state, int processingTimeoutSeconds, DateTime now)
        {
            return state.CurrentStatus == ApiStatus.MSG_RECEIVED
                && (now - state.ReceivedAt).TotalSeconds >= processingTimeoutSeconds;
        }
    }
}
