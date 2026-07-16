import { FileStatus } from '../state/file-status';

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: FileStatus | null,
    public readonly to: FileStatus
  ) {
    super(`Invalid state transition: ${from ?? '(none)'} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class InterfaceMismatchError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly interfaceId: string
  ) {
    super(`File path ${filePath} does not match interface ${interfaceId}`);
    this.name = 'InterfaceMismatchError';
  }
}
