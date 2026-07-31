import { randomUUID } from 'node:crypto';
import type { FileEvent, FileObservation, FileStatus } from '@packages/contracts';

export function buildFileEvent(
  observation: FileObservation,
  status: FileStatus,
  batchId: string,
  now: Date
): FileEvent {
  return {
    eventId: randomUUID(),
    eventType: status,
    batchId,
    interfaceId: observation.interfaceId,
    filePath: observation.path,
    occurredAt: now,
  };
}
