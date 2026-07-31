using System;
using System.IO;
using System.Linq;
using System.Threading;
using Microsoft.Xrm.Sdk;
using FileWatcherMonitoring.Dataverse;
using FileWatcherMonitoring.Dataverse.Tests;
using FileWatcherMonitoring.Plugins;

namespace FileWatcherMonitoring.Simulator
{
    /// <summary>
    /// Local end-to-end simulator — the whole D365 pipeline on your laptop, no
    /// environment needed. This process plays the Power Automate watch flow
    /// (listing a real local folder), the observation rows go through the SAME
    /// ObservationProcessor / SweepProcessor / DataverseStateRepository sources
    /// the plugin ships, against the in-memory FakeOrganizationService.
    ///
    ///   dotnet run --project d365/FileWatcherMonitoring.Simulator -- ./watched
    ///
    /// Then drop/edit/copy .csv files into ./watched and watch the lifecycle:
    /// FILE_DETECTED -> FILE_STABLE -> FILE_DUPLICATE, stuck detection, and the
    /// SLA sweep. Options:
    ///   --stability N   seconds a size must hold to go FILE_STABLE   (default 10)
    ///   --stuck N       seconds before an unstable file is FILE_STUCK (default 120)
    ///   --sla HH:mm     UTC daily deadline for the sweep              (default 23:59)
    ///   --interval N    poll seconds (the "flow recurrence")          (default 2)
    /// </summary>
    internal static class Program
    {
        private const string InterfaceId = "SIM-001";

        private static int Main(string[] args)
        {
            if (args.Length == 0 || args[0].StartsWith("--"))
            {
                Console.Error.WriteLine("Usage: dotnet run -- <folder-to-watch> [--stability 10] [--stuck 120] [--sla 23:59] [--interval 2]");
                return 1;
            }
            var folder = Path.GetFullPath(args[0]);
            Directory.CreateDirectory(folder);
            int stability = IntOption(args, "--stability", 10);
            int stuck = IntOption(args, "--stuck", 120);
            string sla = StringOption(args, "--sla", "23:59");
            int interval = IntOption(args, "--interval", 2);

            var service = new FakeOrganizationService();
            SeedInterface(service, stability, stuck, sla);

            Console.WriteLine($"Watching {folder}  (pattern *.csv, stability {stability}s, stuck {stuck}s, SLA {sla} UTC, poll {interval}s)");
            Console.WriteLine("Drop .csv files in, grow them, re-copy them. Ctrl+C to stop.\n");

            var seenEvents = 0;
            while (true)
            {
                var now = DateTime.UtcNow;

                foreach (var file in Directory.EnumerateFiles(folder, "*.csv"))
                {
                    var info = new FileInfo(file);
                    var row = new Entity(Schema.FileObservationTable.LogicalName);
                    row[Schema.FileObservationTable.InterfaceId] = InterfaceId;
                    row[Schema.FileObservationTable.FilePath] = info.FullName;
                    row[Schema.FileObservationTable.FileSizeBytes] = info.Length;
                    row[Schema.FileObservationTable.ModifiedAt] = info.LastWriteTimeUtc;
                    row[Schema.FileObservationTable.ObservedAt] = now;

                    try
                    {
                        ObservationProcessor.Process(service, row, now);
                    }
                    catch (Exception ex)
                    {
                        Log(ConsoleColor.Red, $"ENGINE REJECTED {info.Name}: {ex.Message}");
                    }
                }

                SweepProcessor.Run(service, InterfaceId, now);

                seenEvents = PrintNewEvents(service, seenEvents);
                Thread.Sleep(TimeSpan.FromSeconds(interval));
            }
        }

        private static int PrintNewEvents(FakeOrganizationService service, int alreadyPrinted)
        {
            var events = service.Rows(Schema.FileEventTable.LogicalName);
            for (var i = alreadyPrinted; i < events.Count; i++)
            {
                var e = events[i];
                var type = Schema.FromChoice(e.GetAttributeValue<OptionSetValue>(Schema.FileEventTable.EventType).Value);
                var path = e.GetAttributeValue<string>(Schema.FileEventTable.FilePath);
                var batch = e.GetAttributeValue<string>(Schema.FileEventTable.BatchId);
                var color = type == FileStatus.FILE_STUCK || type == FileStatus.FILE_MISSING_BY_SLA
                    ? ConsoleColor.Yellow
                    : type == FileStatus.FILE_DUPLICATE ? ConsoleColor.Magenta : ConsoleColor.Green;
                Log(color, $"{type,-20} {(path == null ? "(no file — SLA)" : Path.GetFileName(path)),-30} batch {batch.Substring(0, 8)}");
            }
            return events.Count;
        }

        private static void SeedInterface(FakeOrganizationService service, int stability, int stuck, string sla)
        {
            var row = new Entity(Schema.InterfaceTable.LogicalName);
            row[Schema.InterfaceTable.InterfaceId] = InterfaceId;
            row[Schema.InterfaceTable.Name] = "Local simulator interface";
            row[Schema.InterfaceTable.InboundPath] = "/";
            row[Schema.InterfaceTable.FilePattern] = ".*\\.csv$";
            row[Schema.InterfaceTable.PollIntervalSeconds] = 2;
            row[Schema.InterfaceTable.StabilityCheckSeconds] = stability;
            row[Schema.InterfaceTable.DuplicateCheckEnabled] = true;
            row[Schema.InterfaceTable.StuckThresholdSeconds] = stuck;
            row[Schema.InterfaceTable.SlaDeadline] = sla;
            row[Schema.InterfaceTable.Enabled] = true;
            service.Create(row);
        }

        private static void Log(ConsoleColor color, string message)
        {
            Console.ForegroundColor = color;
            Console.WriteLine($"{DateTime.UtcNow:HH:mm:ss}  {message}");
            Console.ResetColor();
        }

        private static int IntOption(string[] args, string name, int fallback)
        {
            var i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? int.Parse(args[i + 1]) : fallback;
        }

        private static string StringOption(string[] args, string name, string fallback)
        {
            var i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : fallback;
        }
    }
}
