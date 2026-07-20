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

export class ActionCommandExecutionError extends Error {
  constructor(
    command: string,
    readonly exitCode: number,
    readonly output: string,
  ) {
    super(`${command} failed with exit code ${exitCode}.`);
    this.name = 'ActionCommandExecutionError';
  }
}

export function boundedErrorMessage(error: unknown, oversizedMessage: string, maximumCharacters = 2_000): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= maximumCharacters ? message : oversizedMessage;
}
