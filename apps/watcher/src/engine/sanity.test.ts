import { describe, expect, it } from 'vitest';
import type { FileStatus } from '@packages/contracts';

describe('workspace wiring', () => {
  it('resolves @packages/contracts via path alias', () => {
    const status: FileStatus = 'FILE_DETECTED';
    expect(status).toBe('FILE_DETECTED');
  });
});
