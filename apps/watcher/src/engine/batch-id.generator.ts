import { randomUUID } from 'node:crypto';

export function generateBatchId(): string {
  return randomUUID();
}
