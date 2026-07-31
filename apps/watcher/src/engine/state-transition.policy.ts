import type { FileStatus } from '@packages/contracts';
import { InvalidStateTransitionError } from '@packages/contracts';

const NONE = '(none)';

const VALID_TRANSITIONS: Record<string, FileStatus[]> = {
  [NONE]: ['FILE_DETECTED', 'FILE_MISSING_BY_SLA'],
  FILE_DETECTED: ['FILE_STABLE', 'FILE_STUCK'],
  FILE_STABLE: ['FILE_DUPLICATE'],
  FILE_STUCK: ['FILE_STABLE'],
  FILE_DUPLICATE: [],
  FILE_MISSING_BY_SLA: ['FILE_MISSING_BY_SLA'],
};

export function assertValidTransition(from: FileStatus | null, to: FileStatus): void {
  const key = from ?? NONE;
  const allowed = VALID_TRANSITIONS[key] ?? [];
  if (!allowed.includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}
