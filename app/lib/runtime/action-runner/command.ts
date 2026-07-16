import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { cleanBuildOutput } from 'ghostbuild-agent/utils/shell';
import { streamOutput } from '~/utils/process';
import { ActionCommandExecutionError, ActionCommandTimeoutError } from './errors';

const logger = createScopedLogger('ActionRunner.Command');

export async function runCommand(args: {
  container: WebContainer;
  command: string[];
  displayName?: string;
  abortSignal: AbortSignal;
  onOutput: (output: string) => void;
  env?: Record<string, string | number | boolean>;
  timeoutMs?: number;
}): Promise<void> {
  const commandText = args.displayName ?? args.command.join(' ');
  logger.info('starting to run', commandText);
  args.onOutput(`Running ${commandText}...\n`);
  args.abortSignal.throwIfAborted();
  const startedAt = performance.now();
  let latestOutput = '';
  let process: WebContainerProcess | undefined;
  let spawnPromise: Promise<WebContainerProcess> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise =
    args.timeoutMs === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new ActionCommandTimeoutError(commandText, args.timeoutMs!, cleanBuildOutput(latestOutput)));
          }, args.timeoutMs);
        });
  let rejectOnAbort: (reason?: unknown) => void = () => undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });
  const abortListener = () => {
    rejectOnAbort(args.abortSignal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
  };
  try {
    args.abortSignal.addEventListener('abort', abortListener, { once: true });
    spawnPromise = args.env
      ? args.container.spawn(args.command[0], args.command.slice(1), { env: args.env })
      : args.container.spawn(args.command[0], args.command.slice(1));
    process = await Promise.race([spawnPromise, abortPromise, ...(timeoutPromise ? [timeoutPromise] : [])]);
    args.abortSignal.throwIfAborted();
    const execution = streamOutput(process, {
      onOutput: (output) => {
        latestOutput = output;
        args.onOutput(output);
      },
      debounceMs: 50,
    });
    const { output, exitCode } = await Promise.race([
      execution,
      abortPromise,
      ...(timeoutPromise ? [timeoutPromise] : []),
    ]);
    if (exitCode !== 0) {
      throw new ActionCommandExecutionError(commandText, exitCode, cleanBuildOutput(output));
    }
    logger.debug('finished', commandText, 'in', Math.round(performance.now() - startedAt));
  } catch (error) {
    if (process) {
      process.kill();
    } else if (spawnPromise) {
      void spawnPromise
        .then((lateProcess) => lateProcess.kill())
        .catch((spawnError) => logger.debug('Command spawn failed after cancellation', spawnError));
    }
    throw error;
  } finally {
    args.abortSignal.removeEventListener('abort', abortListener);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
