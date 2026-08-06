import { type TrackedSandboxProcess, terminateTrackedSandboxProcess } from './tracked-command';

export class ProjectValidationCancelledError extends Error {
  constructor() {
    super('Project validation was cancelled by the project owner.');
    this.name = 'ProjectValidationCancelledError';
  }
}

export class ValidationCancellation {
  #cancelled = false;
  #cancellation: Promise<void> | null = null;
  #process: TrackedSandboxProcess | null = null;

  requireActive(): void {
    if (this.#cancelled) {
      throw new ProjectValidationCancelledError();
    }
  }

  async attachProcess(process: TrackedSandboxProcess): Promise<void> {
    this.#process = process;
    if (this.#cancelled) {
      await terminateTrackedSandboxProcess(process);
      throw new ProjectValidationCancelledError();
    }
  }

  detachProcess(process: TrackedSandboxProcess): void {
    if (this.#process === process) {
      this.#process = null;
    }
  }

  cancel(): Promise<void> {
    this.#cancelled = true;
    this.#cancellation ??= this.#process ? terminateTrackedSandboxProcess(this.#process) : Promise.resolve();
    return this.#cancellation;
  }
}
