import type { ExecOptions, ProcessExit, ProcessOutput, ProcessStatus, SandboxCommand } from '@cloudflare/sandbox';

const MAX_SANDBOX_FAILURE_MESSAGE_LENGTH = 4_000;
const SANDBOX_OUTPUT_BYTES = MAX_SANDBOX_FAILURE_MESSAGE_LENGTH * 2;
const PROCESS_OBSERVATION_GRACE_MS = 30_000;
const LOCAL_PROCESS_DEADLINE = Symbol('local-process-deadline');

export type TrackedSandboxProcess = {
  readonly id: string;
  output(options: { encoding: 'utf8'; maxBytes: number; timeout: number }): Promise<ProcessOutput<string>>;
  waitForExit(options: { timeout: number }): Promise<ProcessExit>;
  kill(signal?: number): Promise<void>;
  status(): Promise<ProcessStatus>;
};

export class SandboxProcessTerminationUnconfirmedError extends Error {
  constructor() {
    super('Sandbox command termination could not be confirmed. Cleanup was deferred.');
    this.name = 'SandboxProcessTerminationUnconfirmedError';
  }
}

type RunTrackedSandboxCommandOptions = {
  command: SandboxCommand;
  timeout: number;
  exec: (command: SandboxCommand, options: ExecOptions) => Promise<TrackedSandboxProcess>;
  onProcess?: (process: TrackedSandboxProcess) => void | Promise<void>;
};

export async function runTrackedSandboxCommand(options: RunTrackedSandboxCommandOptions): Promise<void> {
  // @next exec resolves on launch, so the remote timeout belongs on exec and completion is observed through the handle.
  const process = await options.exec(options.command, { timeout: options.timeout });
  await options.onProcess?.(process);
  let result: ProcessOutput<string>;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      process.output({
        encoding: 'utf8',
        maxBytes: SANDBOX_OUTPUT_BYTES,
        timeout: options.timeout + PROCESS_OBSERVATION_GRACE_MS,
      }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(LOCAL_PROCESS_DEADLINE), options.timeout + PROCESS_OBSERVATION_GRACE_MS);
      }),
    ]);
  } catch (error) {
    await terminateTrackedSandboxProcess(process);
    if (error === LOCAL_PROCESS_DEADLINE) {
      throw new Error(`Sandbox command timed out after ${options.timeout}ms and was terminated.`);
    }
    throw new Error(`Sandbox command could not be observed for ${options.timeout}ms and was terminated.`);
  } finally {
    clearTimeout(deadline);
  }
  if (result.timedOut) {
    throw new Error(
      sandboxCommandFailureMessage(result, {
        summary: `Sandbox command timed out after ${options.timeout}ms.`,
      }),
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      sandboxCommandFailureMessage(result, {
        summary: `Sandbox command failed with exit code ${result.exitCode}.`,
      }),
    );
  }
}

export async function terminateTrackedSandboxProcess(process: TrackedSandboxProcess): Promise<void> {
  await process.kill(9).catch(() => undefined);
  try {
    await process.waitForExit({ timeout: 10_000 });
    return;
  } catch {
    // A kill can race an already-completed process or a transient RPC failure; status is the final confirmation.
  }
  let status: ProcessStatus;
  try {
    status = await process.status();
  } catch {
    throw new SandboxProcessTerminationUnconfirmedError();
  }
  if (status.state === 'running') {
    throw new SandboxProcessTerminationUnconfirmedError();
  }
}

export function sandboxCommandFailureMessage(
  result: { stdout: string; stderr: string },
  { summary = 'Sandbox command failed.' }: { summary?: string } = {},
): string {
  const availableOutputLength = Math.max(0, MAX_SANDBOX_FAILURE_MESSAGE_LENGTH - summary.length - 1);
  const output = boundedSandboxOutput(result, availableOutputLength);
  if (!output) {
    return summary;
  }
  return `${summary}\n${output}`;
}

function boundedSandboxOutput(result: { stdout: string; stderr: string }, maxLength: number): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  if (maxLength === 0 || (!stderr && !stdout)) {
    return '';
  }
  if (!stderr) {
    return stdout.slice(-maxLength);
  }
  if (!stdout || maxLength === 1) {
    return stderr.slice(-maxLength);
  }
  const contentLength = maxLength - 1;
  const preferredStderrLength = Math.min(stderr.length, Math.ceil((contentLength * 2) / 3));
  const stdoutLength = Math.min(stdout.length, contentLength - preferredStderrLength);
  const stderrLength = Math.min(stderr.length, contentLength - stdoutLength);
  return `${stderr.slice(-stderrLength)}\n${stdout.slice(-stdoutLength)}`;
}
