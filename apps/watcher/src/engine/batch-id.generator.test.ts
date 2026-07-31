import { describe, expect, it } from 'vitest';
import { generateBatchId } from './batch-id.generator';

describe('generateBatchId', () => {
  it('returns a non-empty string', () => {
    expect(generateBatchId().length).toBeGreaterThan(0);
  });

  it('returns a different id on each call', () => {
    expect(generateBatchId()).not.toBe(generateBatchId());
  });
});
