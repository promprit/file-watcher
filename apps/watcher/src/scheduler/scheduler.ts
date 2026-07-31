import type {
  FileEvent,
  InterfaceConfig,
  StateRepository,
} from '@packages/contracts';
import type { Adapter, ConnectionContext, InterfaceScope } from '../adapters/adapter';
import { processObservation } from '../engine/watcher-engine';
import { checkMissingSla } from '../engine/missing-sla-sweep';
import { InterfaceConfigRepository } from '../database/repositories/interface-config.repository';
import { ConnectionConfigRepository } from '../database/repositories/connection-config.repository';

export interface EngineDefaults {
  stuckThresholdSeconds: number;
  slaDeadline: string;
}

export type AdapterRegistry = Record<string, Adapter>;

export interface InterfaceRunResult {
  interfaceId: string;
  status: 'ok' | 'error';
  eventCount: number;
  error?: unknown;
}

export interface SchedulerDeps {
  interfaceConfigRepo: InterfaceConfigRepository;
  connectionConfigRepo: ConnectionConfigRepository;
  stateRepo: StateRepository;
  adapterRegistry: AdapterRegistry;
  engineDefaults: EngineDefaults;
}

export async function runOnce(
  deps: SchedulerDeps,
  sink: (event: FileEvent) => void,
  now: Date = new Date()
): Promise<InterfaceRunResult[]> {
  const interfaces = await deps.interfaceConfigRepo.findAll(true);
  const results: InterfaceRunResult[] = [];

  for (const interfaceConfig of interfaces) {
    const fullConfig: InterfaceConfig = {
      ...interfaceConfig,
      ...deps.engineDefaults,
    };

    let eventCount = 0;
    try {
      const connectionConfig = await deps.connectionConfigRepo.findByRef(fullConfig.connectionRef);
      if (!connectionConfig) {
        throw new Error(`Connection config not found: ${fullConfig.connectionRef}`);
      }

      const adapter = deps.adapterRegistry[connectionConfig.storageType];
      if (!adapter) {
        throw new Error(`Unsupported storage type: ${connectionConfig.storageType}`);
      }

      const context: ConnectionContext = {
        connectionRef: connectionConfig.connectionRef,
        storageType: connectionConfig.storageType,
        endpoint: connectionConfig.endpoint,
      };
      const scope: InterfaceScope = {
        interfaceId: fullConfig.interfaceId,
        inboundPath: fullConfig.inboundPath,
        filePattern: fullConfig.filePattern,
      };

      const observations = await adapter.observe(context, scope);

      for (const observation of observations) {
        const event = await processObservation(observation, fullConfig, deps.stateRepo, now);
        if (event) {
          sink(event);
          eventCount += 1;
        }
      }

      const slaEvents = await checkMissingSla(fullConfig, deps.stateRepo, now);
      for (const event of slaEvents) {
        sink(event);
        eventCount += 1;
      }

      results.push({ interfaceId: fullConfig.interfaceId, status: 'ok', eventCount });
    } catch (error) {
      results.push({ interfaceId: fullConfig.interfaceId, status: 'error', eventCount, error });
    }
  }

  return results;
}
