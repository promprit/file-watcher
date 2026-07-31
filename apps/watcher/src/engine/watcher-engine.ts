import { basename } from 'node:path';
import type {
  FileEvent,
  FileObservation,
  FileStatus,
  InterfaceConfig,
  StateRepository,
  WatcherState,
} from '@packages/contracts';
import { assertInterfaceMatch } from './interface-matcher';
import { assertValidTransition } from './state-transition.policy';
import { generateBatchId } from './batch-id.generator';
import { buildFileEvent } from './event-builder';
import type { Rule } from './rules/rule';
import { duplicateRule } from './rules/duplicate.rule';
import { stuckFileRule } from './rules/stuck-file.rule';
import { stabilityRule } from './rules/stability.rule';

const PIPELINE: Rule[] = [duplicateRule, stuckFileRule, stabilityRule];

export async function processObservation(
  observation: FileObservation,
  interfaceConfig: InterfaceConfig,
  stateRepo: StateRepository,
  now: Date = new Date()
): Promise<FileEvent | null> {
  assertInterfaceMatch(observation, interfaceConfig);

  const existingState = await stateRepo.get(observation.interfaceId, observation.path);

  let proposedStatus: FileStatus | null = null;
  for (const rule of PIPELINE) {
    const outcome = rule(observation, existingState, interfaceConfig, now);
    if (outcome) {
      proposedStatus = outcome.status;
      break;
    }
  }

  if (!proposedStatus) {
    if (existingState) {
      return null;
    }
    proposedStatus = 'FILE_DETECTED';
  }

  const currentStatus = existingState ? existingState.currentStatus : null;

  if (proposedStatus === currentStatus) {
    return null;
  }

  assertValidTransition(currentStatus, proposedStatus);

  const batchId = existingState ? existingState.batchId : generateBatchId();

  const newState: WatcherState = {
    interfaceId: observation.interfaceId,
    filePath: observation.path,
    currentStatus: proposedStatus,
    previousStatus: currentStatus,
    batchId,
    firstDetectedAt: existingState ? existingState.firstDetectedAt : now,
    statusChangedAt: now,
    lastSeenAt: now,
    fileName: basename(observation.path),
    fileSizeBytes: observation.size,
  };

  await stateRepo.save(newState);

  return buildFileEvent(observation, proposedStatus, batchId, now);
}
