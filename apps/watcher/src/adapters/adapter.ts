import type { FileObservation } from '@packages/contracts';

export interface ConnectionContext {
  connectionRef: string;
  storageType: string;
  endpoint: string;
}

export interface InterfaceScope {
  interfaceId: string;
  inboundPath: string;
  filePattern: string;
}

export interface Adapter {
  observe(context: ConnectionContext, scope: InterfaceScope): Promise<FileObservation[]>;
}

export class AdapterError extends Error {
  constructor(
    public readonly connectionRef: string,
    public readonly interfaceId: string,
    public readonly cause: unknown
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Adapter error for interface ${interfaceId} (connection ${connectionRef}): ${causeMessage}`
    );
    this.name = 'AdapterError';
  }
}
