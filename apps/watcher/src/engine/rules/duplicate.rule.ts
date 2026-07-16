import { TERMINAL_STATUSES, type Rule } from './rule';

export const duplicateRule: Rule = (observation, state, _config, _now) => {
  if (!state) return null;
  if (!TERMINAL_STATUSES.includes(state.currentStatus)) return null;
  if (state.filePath !== observation.path) return null;
  return { status: 'FILE_DUPLICATE' };
};
