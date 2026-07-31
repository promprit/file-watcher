import type { FileObservation, InterfaceConfig } from '@packages/contracts';
import { InterfaceMismatchError } from '@packages/contracts';

export function assertInterfaceMatch(observation: FileObservation, config: InterfaceConfig): void {
  if (observation.interfaceId !== config.interfaceId) {
    throw new InterfaceMismatchError(observation.path, config.interfaceId);
  }
}
