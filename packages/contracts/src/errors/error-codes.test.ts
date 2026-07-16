import { describe, expect, it } from 'vitest';
import { InvalidStateTransitionError, InterfaceMismatchError } from './error-codes';

describe('InvalidStateTransitionError', () => {
  it('includes from and to statuses in the message', () => {
    const err = new InvalidStateTransitionError('FILE_STABLE', 'FILE_DETECTED');
    expect(err.name).toBe('InvalidStateTransitionError');
    expect(err.from).toBe('FILE_STABLE');
    expect(err.to).toBe('FILE_DETECTED');
    expect(err.message).toContain('FILE_STABLE');
    expect(err.message).toContain('FILE_DETECTED');
  });

  it('renders (none) when from is null', () => {
    const err = new InvalidStateTransitionError(null, 'FILE_STABLE');
    expect(err.message).toContain('(none)');
  });
});

describe('InterfaceMismatchError', () => {
  it('includes the file path and interface id in the message', () => {
    const err = new InterfaceMismatchError('/inbound/foo.csv', 'SA-034');
    expect(err.name).toBe('InterfaceMismatchError');
    expect(err.filePath).toBe('/inbound/foo.csv');
    expect(err.interfaceId).toBe('SA-034');
    expect(err.message).toContain('/inbound/foo.csv');
    expect(err.message).toContain('SA-034');
  });
});
