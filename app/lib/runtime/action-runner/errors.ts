import { z } from 'zod';

export class ActionCommandError extends Error {
  constructor(
    readonly header: string,
    readonly output: string,
  ) {
    super(`Failed To Execute Shell Command: ${header}\n\nOutput:\n${output}`);
    this.name = 'ActionCommandError';
    Object.setPrototypeOf(this, ActionCommandError.prototype);
  }
}

export class ActionCommandTimeoutError extends Error {
  constructor(
    command: string,
    timeoutMs: number,
    readonly output: string,
  ) {
    super(`${command} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'ActionCommandTimeoutError';
  }
}

export function packageInstallErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Error: Invalid package install arguments.  ${error}`;
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return 'Error: An unknown error occurred during package install';
}
