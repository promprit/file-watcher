import type { Rule } from './rule';

export const stabilityRule: Rule = (observation, state, config, now) => {
  if (!state) return null;
  if (state.currentStatus !== 'FILE_DETECTED') return null;
  if (state.fileSizeBytes !== observation.size) return null;
  const elapsedSeconds = (now.getTime() - state.statusChangedAt.getTime()) / 1000;
  if (elapsedSeconds < config.stabilityCheckSeconds) return null;
  return { status: 'FILE_STABLE' };
};
