import { FileStatus } from '../state/file-status';

export interface FileEvent {
  eventId: string;
  eventType: FileStatus;
  batchId: string;
  interfaceId: string;
  filePath: string | null;
  occurredAt: Date;
}
