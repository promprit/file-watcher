using System;
using Microsoft.Xrm.Sdk;
using FileWatcherMonitoring.Plugins;

namespace FileWatcherMonitoring.Dataverse
{
    /// <summary>
    /// The transactional heart of the D365-native watcher. Register SYNCHRONOUS,
    /// PostOperation, on Create of fwm_fileobservation. Because the state upsert
    /// and event insert run on the pipeline IOrganizationService, they commit or
    /// roll back atomically with the observation create — this transaction is why
    /// the old Gateway/outbox pattern is not ported.
    ///
    /// Thin wrapper: all logic lives in ObservationProcessor (unit-tested against a
    /// fake IOrganizationService). Fail-fast: invalid transitions and interface
    /// mismatches surface as InvalidPluginExecutionException (per-observation
    /// isolation is inherent — each create is its own pipeline).
    /// </summary>
    public class FileObservationCreatePlugin : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var factory = (IOrganizationServiceFactory)serviceProvider.GetService(typeof(IOrganizationServiceFactory));
            var service = factory.CreateOrganizationService(context.UserId);

            if (!(context.InputParameters.Contains("Target") && context.InputParameters["Target"] is Entity target)
                || target.LogicalName != Schema.FileObservationTable.LogicalName)
            {
                return;
            }

            try
            {
                ObservationProcessor.Process(service, target, DateTime.UtcNow);
            }
            catch (InterfaceMismatchException ex)
            {
                throw new InvalidPluginExecutionException(ex.Message, ex);
            }
            catch (InvalidStateTransitionException ex)
            {
                throw new InvalidPluginExecutionException(ex.Message, ex);
            }
        }
    }
}
