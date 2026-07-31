import { randomUUID } from 'node:crypto';
import type { FileEvent, InterfaceConfig, StateRepository, WatcherState } from '@packages/contracts';
import { assertValidTransition } from './state-transition.policy';
import { generateBatchId } from './batch-id.generator';

const SLA_SENTINEL_PATH = '__sla_window__';

// slaDeadline is UTC, not local time — no per-interface timezone support in
// this MVP. Day/deadline math below is UTC-based throughout for that reason.
function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function todaysDeadline(slaDeadline: string, now: Date): Date {
  const [hours, minutes] = slaDeadline.split(':').map(Number);
  const deadline = new Date(now);
  deadline.setUTCHours(hours, minutes, 0, 0);
  return deadline;
}

export async function checkMissingSla(
  interfaceConfig: InterfaceConfig,
  stateRepo: StateRepository,
  now: Date
): Promise<FileEvent[]> {
  const deadline = todaysDeadline(interfaceConfig.slaDeadline, now);
  if (now < deadline) {
    return [];
  }

  const states = await stateRepo.findByInterface(interfaceConfig.interfaceId);
  const arrivedToday = states.some(
    (s) => s.filePath !== SLA_SENTINEL_PATH && isSameUtcDay(s.firstDetectedAt, now)
  );
  if (arrivedToday) {
    return [];
  }

  const existingSentinel = await stateRepo.get(interfaceConfig.interfaceId, SLA_SENTINEL_PATH);
  if (
    existingSentinel &&
    existingSentinel.currentStatus === 'FILE_MISSING_BY_SLA' &&
    isSameUtcDay(existingSentinel.statusChangedAt, now)
  ) {
    return [];
  }

  const currentSentinelStatus = existingSentinel ? existingSentinel.currentStatus : null;
  assertValidTransition(currentSentinelStatus, 'FILE_MISSING_BY_SLA');

  const batchId = generateBatchId();
  const newState: WatcherState = {
    interfaceId: interfaceConfig.interfaceId,
    filePath: SLA_SENTINEL_PATH,
    currentStatus: 'FILE_MISSING_BY_SLA',
    previousStatus: currentSentinelStatus,
    batchId,
    firstDetectedAt: now,
    statusChangedAt: now,
    lastSeenAt: now,
    fileName: SLA_SENTINEL_PATH,
    fileSizeBytes: 0,
  };
  await stateRepo.save(newState);

  const event: FileEvent = {
    eventId: randomUUID(),
    eventType: 'FILE_MISSING_BY_SLA',
    batchId,
    interfaceId: interfaceConfig.interfaceId,
    filePath: null,
    occurredAt: now,
  };

  return [event];
}
