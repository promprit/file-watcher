// State management types (upstream's, canonical)
export type { FileStatus } from './state/file-status';
export type { WatcherState } from './state/watcher-state';
export type { StateRepository } from './state/state-repository';

// Configuration types
export type { InterfaceConfig } from './config/interface-config';
export type { ConnectionConfig } from './config/connection-config';

// Event/observation types (ours)
export * from './events/file-event';
export * from './observations/file-observation';

// Error classes (ours)
export * from './errors/error-codes';
