const MAX_SANDBOX_FAILURE_MESSAGE_LENGTH = 4_000;

export type TrackedSandboxProcess = {
  waitForExit(timeout?: number): Promise<{ exitCode: number }>;
  kill(signal?: string): Promise<void>;
  getStatus(): Promise<'starting' | 'running' | 'completed' | 'failed' | 'killed' | 'error'>;
  getLogs(): Promise<{ stdout: string; stderr: string }>;
};

export class SandboxProcessTerminationUnconfirmedError extends Error {
  constructor() {
    super('Sandbox command termination could not be confirmed. Cleanup was deferred.');
    this.name = 'SandboxProcessTerminationUnconfirmedError';
  }
}

type RunTrackedSandboxCommandOptions = {
  command: string;
  timeout: number;
  processId: string;
  startProcess: (
    command: string,
    options: {
      processId: string;
      autoCleanup: false;
      onOutput: (stream: 'stdout' | 'stderr', data: string) => void;
    },
  ) => Promise<TrackedSandboxProcess>;
  onProcess?: (process: TrackedSandboxProcess) => void | Promise<void>;
};

export async function runTrackedSandboxCommand(options: RunTrackedSandboxCommandOptions): Promise<void> {
  const logs = { stdout: '', stderr: '' };
  const process = await options.startProcess(options.command, {
    processId: options.processId,
    autoCleanup: false,
    onOutput: (stream, data) => {
      logs[stream] = `${logs[stream]}${data}`.slice(-MAX_SANDBOX_FAILURE_MESSAGE_LENGTH);
    },
  });
  await options.onProcess?.(process);
  let exitCode: number;
  try {
    exitCode = (await process.waitForExit(options.timeout)).exitCode;
  } catch {
    await terminateTrackedSandboxProcess(process);
    await recoverTrackedSandboxProcessLogs(process, logs);
    throw new Error(
      sandboxCommandFailureMessage(logs, {
        summary: `Sandbox command timed out after ${options.timeout}ms.`,
      }),
    );
  }
  if (exitCode !== 0) {
    await recoverTrackedSandboxProcessLogs(process, logs);
    throw new Error(
      sandboxCommandFailureMessage(logs, {
        summary: `Sandbox command failed with exit code ${exitCode}.`,
      }),
    );
  }
}

async function recoverTrackedSandboxProcessLogs(
  process: TrackedSandboxProcess,
  streamedLogs: { stdout: string; stderr: string },
): Promise<void> {
  const persistedLogs = await process.getLogs().catch(() => undefined);
  if (!persistedLogs) {
    return;
  }
  for (const stream of ['stdout', 'stderr'] as const) {
    if (persistedLogs[stream]) {
      streamedLogs[stream] = persistedLogs[stream].slice(-MAX_SANDBOX_FAILURE_MESSAGE_LENGTH);
    }
  }
}

export async function terminateTrackedSandboxProcess(process: TrackedSandboxProcess): Promise<void> {
  await process.kill('SIGKILL').catch(() => undefined);
  let status: Awaited<ReturnType<TrackedSandboxProcess['getStatus']>>;
  try {
    status = await process.getStatus();
  } catch {
    throw new SandboxProcessTerminationUnconfirmedError();
  }
  if (status === 'starting' || status === 'running') {
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
