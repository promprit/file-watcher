import { TERMINAL_STATUSES, type Rule } from './rule';

export const stuckFileRule: Rule = (_observation, state, config, now) => {
  if (!state) return null;
  if (TERMINAL_STATUSES.includes(state.currentStatus)) return null;
  const elapsedSeconds = (now.getTime() - state.firstDetectedAt.getTime()) / 1000;
  if (elapsedSeconds < config.stuckThresholdSeconds) return null;
  return { status: 'FILE_STUCK' };
};
