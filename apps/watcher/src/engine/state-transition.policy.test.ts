import { describe, expect, it } from 'vitest';
import { InvalidStateTransitionError } from '@packages/contracts';
import { assertValidTransition } from './state-transition.policy';

describe('assertValidTransition', () => {
  const validCases: Array<[string | null, string]> = [
    [null, 'FILE_DETECTED'],
    [null, 'FILE_MISSING_BY_SLA'],
    ['FILE_DETECTED', 'FILE_STABLE'],
    ['FILE_DETECTED', 'FILE_STUCK'],
    ['FILE_STABLE', 'FILE_DUPLICATE'],
    ['FILE_STUCK', 'FILE_STABLE'],
  ];

  it.each(validCases)('allows %s -> %s', (from, to) => {
    expect(() =>
      assertValidTransition(from as any, to as any)
    ).not.toThrow();
  });

  const invalidCases: Array<[string | null, string]> = [
    ['FILE_STABLE', 'FILE_DETECTED'],
    ['FILE_DUPLICATE', 'FILE_STABLE'],
    ['FILE_STUCK', 'FILE_DUPLICATE'],
    ['FILE_DETECTED', 'FILE_MISSING_BY_SLA'],
    [null, 'FILE_STABLE'],
  ];

  it.each(invalidCases)('rejects %s -> %s', (from, to) => {
    expect(() => assertValidTransition(from as any, to as any)).toThrow(
      InvalidStateTransitionError
    );
  });
});
