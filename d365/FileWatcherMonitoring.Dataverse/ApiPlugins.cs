using System;
using Microsoft.Xrm.Sdk;
using FileWatcherMonitoring.Plugins;

namespace FileWatcherMonitoring.Dataverse
{
    /// <summary>
    /// Backing plugin for Custom API fwm_ReportApiMessage — the single entry point
    /// API-type integrations (or F&O business-event flows) call to self-report.
    ///
    /// Custom API definition (created by provision.py):
    ///   Request:  InterfaceId (String, required), MessageId (String, required),
    ///             Action (String, required: Received|Processed|Failed),
    ///             CorrelationId (String, optional), ErrorCode (String, optional)
    ///   Response: Status (String — the recorded status, or "NO_CHANGE")
    /// </summary>
    public class ReportApiMessagePlugin : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);

            var interfaceId = RequiredString(context, "InterfaceId");
            var messageId = RequiredString(context, "MessageId");
            var actionText = RequiredString(context, "Action");
            var correlationId = OptionalString(context, "CorrelationId");
            var errorCode = OptionalString(context, "ErrorCode");

            ApiReportAction action;
            if (!Enum.TryParse(actionText, true, out action))
            {
                throw new InvalidPluginExecutionException(
                    "Action must be Received, Processed, or Failed — got '" + actionText + "'");
            }

            try
            {
                var status = ApiMessageProcessor.Report(
                    service, interfaceId, messageId, action, correlationId, errorCode, DateTime.UtcNow);
                context.OutputParameters["Status"] = status.HasValue ? status.Value.ToString() : "NO_CHANGE";
            }
            catch (InvalidApiTransitionException ex)
            {
                throw new InvalidPluginExecutionException(ex.Message, ex);
            }
            catch (UnknownApiMessageException ex)
            {
                throw new InvalidPluginExecutionException(ex.Message, ex);
            }
        }

        private static string RequiredString(IPluginExecutionContext context, string name)
        {
            var value = context.InputParameters.Contains(name) ? context.InputParameters[name] as string : null;
            if (string.IsNullOrEmpty(value))
            {
                throw new InvalidPluginExecutionException("fwm_ReportApiMessage requires the " + name + " parameter.");
            }
            return value;
        }

        private static string OptionalString(IPluginExecutionContext context, string name)
        {
            return context.InputParameters.Contains(name) ? context.InputParameters[name] as string : null;
        }
    }

    /// <summary>
    /// Backing plugin for Custom API fwm_CheckApiSla — timeout sweep + feed heartbeat
    /// for one API interface per call (same pacing rationale as fwm_CheckMissingSla).
    ///   Request:  InterfaceId (String, required)
    ///   Response: EventCount (Integer)
    /// </summary>
    public class CheckApiSlaPlugin : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);

            var interfaceId = context.InputParameters.Contains("InterfaceId")
                ? context.InputParameters["InterfaceId"] as string
                : null;
            if (string.IsNullOrEmpty(interfaceId))
            {
                throw new InvalidPluginExecutionException("fwm_CheckApiSla requires the InterfaceId parameter.");
            }

            context.OutputParameters["EventCount"] = ApiMessageProcessor.CheckSla(service, interfaceId, DateTime.UtcNow);
        }
    }
}
