import { describe, expect, it } from 'vitest';
import { AdapterError } from './adapter';

describe('AdapterError', () => {
  it('includes connectionRef, interfaceId, and the cause message', () => {
    const cause = new Error('ENOENT: no such file or directory');
    const err = new AdapterError('folder-conn-1', 'SA-034', cause);

    expect(err.name).toBe('AdapterError');
    expect(err.connectionRef).toBe('folder-conn-1');
    expect(err.interfaceId).toBe('SA-034');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('folder-conn-1');
    expect(err.message).toContain('SA-034');
    expect(err.message).toContain('ENOENT');
  });

  it('stringifies a non-Error cause', () => {
    const err = new AdapterError('folder-conn-1', 'SA-034', 'plain string cause');
    expect(err.message).toContain('plain string cause');
  });
});
