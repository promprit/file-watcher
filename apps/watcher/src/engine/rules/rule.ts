import type { FileObservation, FileStatus, InterfaceConfig, WatcherState } from '@packages/contracts';

export interface RuleOutcome {
  status: FileStatus;
}

export type Rule = (
  observation: FileObservation,
  state: WatcherState | null,
  config: InterfaceConfig,
  now: Date
) => RuleOutcome | null;

export const TERMINAL_STATUSES: FileStatus[] = ['FILE_STABLE', 'FILE_DUPLICATE'];
