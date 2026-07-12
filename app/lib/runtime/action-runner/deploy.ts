import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { cleanBuildOutput } from 'ghostbuild-agent/utils/shell';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';
import { getAuthToken } from '~/lib/stores/sessionId';
import { isGuestSessionId } from '~/lib/guest-session';
import { streamOutput } from '~/utils/process';
import { ActionCommandTimeoutError } from './errors';
import type { ActionRunnerWorkspace } from './types';

const logger = createScopedLogger('ActionRunner.Deploy');
const GUEST_APP_CHECK_COMPLETE = 'Ghostbuild app check complete. Sign in to deploy this app to Cloudflare production.';
const GENERATED_ROUTE_PATH = 'src/routes/index.tsx';
const STARTER_ROUTE_MARKERS = ['Ghostbuild on Cloudflare', 'Start with a durable AI agent.', 'App Agent'] as const;

export async function runDeploy(args: {
  container: WebContainer;
  abortSignal: AbortSignal;
  onOutput: (output: string) => void;
  workspace: ActionRunnerWorkspace;
}): Promise<string> {
  const commandErroredController = new AbortController();
  const abortSignal = AbortSignal.any([args.abortSignal, commandErroredController.signal]);
  const run = (command: string[], options?: RunCommandOptions) =>
    runCommand({
      container: args.container,
      command,
      abortSignal,
      commandErroredController,
      onOutput: args.onOutput,
      ...options,
    });

  const startedAt = performance.now();
  const sessionId = getAuthToken();
  let result = '';

  if (!sessionId || isGuestSessionId(sessionId)) {
    await validateGuestGeneratedApp(args.container);
    result += GUEST_APP_CHECK_COMPLETE;
  } else {
    await waitForContainerBootState(ContainerBootState.READY);
    result += await run(['pnpm', 'run', 'deploy']);
  }

  logger.info('deploy action finished in', performance.now() - startedAt);
  return result;
}

async function validateGuestGeneratedApp(container: WebContainer): Promise<void> {
  let routeContent: string;
  try {
    routeContent = await container.fs.readFile(GENERATED_ROUTE_PATH, 'utf-8');
  } catch (error) {
    throw new Error(`Generated app route is missing: ${GENERATED_ROUTE_PATH}`, { cause: error });
  }

  if (routeContent.trim().length === 0) {
    throw new Error(`Generated app route is empty: ${GENERATED_ROUTE_PATH}`);
  }

  if (STARTER_ROUTE_MARKERS.every((marker) => routeContent.includes(marker))) {
    throw new Error(`Generated app route still matches the starter template: ${GENERATED_ROUTE_PATH}`);
  }
}

type RunCommandOptions = {
  env?: Record<string, string | number | boolean>;
  timeoutMs?: number;
};

export async function runCommand(args: {
  container: WebContainer;
  command: string[];
  abortSignal: AbortSignal;
  commandErroredController: AbortController;
  onOutput: (output: string) => void;
  env?: Record<string, string | number | boolean>;
  timeoutMs?: number;
}): Promise<string> {
  const commandText = args.command.join(' ');
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
            reject(new ActionCommandTimeoutError(commandText, args.timeoutMs!, latestOutput));
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
    spawnPromise = args.container.spawn(
      args.command[0],
      args.command.slice(1),
      args.env ? { env: args.env } : undefined,
    );
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
    const cleanedOutput = cleanBuildOutput(output);
    if (exitCode !== 0) {
      args.commandErroredController.abort(commandText);
      throw new Error(`${commandText} failed with exit code ${exitCode}: ${cleanedOutput}`);
    }
    logger.debug('finished', commandText, 'in', Math.round(performance.now() - startedAt));
    return cleanedOutput.trim().length === 0 ? '' : `${cleanedOutput}\n\n`;
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
