import type { WebContainer } from '@webcontainer/api';
import { path as nodePath } from 'ghostbuild-agent/utils/path';
import { atom, map, type MapStore, type WritableAtom } from 'nanostores';
import type { ActionAlert } from '~/types/actions';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { unreachable } from 'ghostbuild-agent/utils/unreachable';
import type { ActionCallbackData } from 'ghostbuild-agent/message-parser';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { viewParameters } from 'ghostbuild-agent/tools/view';
import { renderDirectory } from 'ghostbuild-agent/utils/renderDirectory';
import { renderFile } from 'ghostbuild-agent/utils/renderFile';
import { readPath, workDirRelative } from '~/utils/fileUtils';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';
import { npmInstallToolParameters, splitPackageSpecs } from 'ghostbuild-agent/tools/npmInstall';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { z } from 'zod';
import { editToolParameters } from 'ghostbuild-agent/tools/edit';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { cleanBuildOutput } from 'ghostbuild-agent/utils/shell';
import type { ArtifactAction } from 'ghostbuild-agent/types';
import { streamOutput } from '~/utils/process';
import type { GhostbuildToolName } from '~/lib/common/types';
import { lookupDocsParameters, docs, type DocKey } from 'ghostbuild-agent/tools/lookupDocs';
import { assertNotLocalSecretFilePath } from '~/utils/secretFiles';
import { assertValidGeneratedPackageJson } from '~/utils/generatedPackageManifest';

const logger = createScopedLogger('ActionRunner');

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export function isActionStatusActive(status: ActionStatus): boolean {
  return status === 'pending' || status === 'running';
}

type BaseActionState = ArtifactAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;
};

type FailedActionState = ArtifactAction &
  Omit<BaseActionState, 'status'> & {
    status: Extract<ActionStatus, 'failed'>;
    error: string;
  };

export type ActionState = (BaseActionState | FailedActionState) & { isEdit?: boolean };

type BaseActionUpdate = Partial<Pick<BaseActionState, 'status' | 'abort' | 'executed' | 'content'>>;

type ActionStateUpdate =
  BaseActionUpdate | (Omit<BaseActionUpdate, 'status'> & { status: 'failed'; error: string }) | { output: string };

type ActionsMap = MapStore<Record<string, ActionState>>;

class ActionCommandError extends Error {
  readonly _output: string;
  readonly _header: string;

  constructor(message: string, output: string) {
    // Create a formatted message that includes both the error message and output
    const formattedMessage = `Failed To Execute Shell Command: ${message}\n\nOutput:\n${output}`;
    super(formattedMessage);

    // Set the output separately so it can be accessed programmatically
    this._header = message;
    this._output = output;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, ActionCommandError.prototype);

    // Set the name of the error for better debugging
    this.name = 'ActionCommandError';
  }

  // Optional: Add a method to get just the terminal output
  get output() {
    return this._output;
  }
  get header() {
    return this._header;
  }
}

function packageInstallErrorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return `Error: Invalid package install arguments.  ${error}`;
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }

  return 'Error: An unknown error occurred during package install';
}

export class ActionRunner {
  #webcontainer: Promise<WebContainer>;
  #currentExecutionPromise: Promise<void> = Promise.resolve();
  #previousToolCalls: Map<string, { toolName: string; args: unknown }> = new Map();
  runnerId = atom<string>(`${Date.now()}`);
  actions: ActionsMap = map({});
  onAlert?: (alert: ActionAlert) => void;
  buildOutput?: { path: string; exitCode: number; output: string };
  terminalOutput: WritableAtom<string> = atom('');
  onToolCallComplete: (args: {
    kind: 'success' | 'error';
    result: string;
    toolCallId: string;
    toolName: GhostbuildToolName;
  }) => void;
  constructor(
    webcontainerPromise: Promise<WebContainer>,
    callbacks: {
      onAlert?: (alert: ActionAlert) => void;
      onToolCallComplete: (args: {
        kind: 'success' | 'error';
        result: string;
        toolCallId: string;
        toolName: GhostbuildToolName;
      }) => void;
    },
  ) {
    this.#webcontainer = webcontainerPromise;
    this.onAlert = callbacks.onAlert;
    this.onToolCallComplete = callbacks.onToolCallComplete;
  }

  addAction(data: ActionCallbackData) {
    const { actionId } = data;

    const actions = this.actions.get();
    const action = actions[actionId];

    if (action) {
      if (action.content !== data.action.content) {
        this.updateAction(actionId, { ...action, content: data.action.content });
      }
      return;
    }

    const abortController = new AbortController();

    if (data.action.type === 'file') {
      const files = workbenchStore.files.get();
      const absPath = getAbsolutePath(data.action.filePath);
      const existing = !!files[absPath];
      data.action.isEdit = existing;
    }

    this.actions.setKey(actionId, {
      ...data.action,
      status: 'pending',
      executed: false,
      abort: () => {
        abortController.abort();
        this.updateAction(actionId, { status: 'aborted' });
      },
      abortSignal: abortController.signal,
    });

    this.#currentExecutionPromise.then(() => {
      this.updateAction(actionId, { status: 'running' });
    });
  }

  async runAction(data: ActionCallbackData, args: { isStreaming: boolean }) {
    const { actionId } = data;
    const action = this.actions.get()[actionId];

    if (!action) {
      unreachable(`Action ${actionId} not found`);
    }

    if (action.executed) {
      return; // No return value here
    }

    if (args.isStreaming && action.type !== 'file') {
      return; // No return value here
    }

    // Check for duplicate tool calls
    if (action.type === 'toolUse') {
      const parsed = action.parsedContent;
      if (parsed.state === 'call') {
        const key = `${parsed.toolName}:${JSON.stringify(parsed.args)}`;
        const previousCall = this.#previousToolCalls.get(key);
        if (previousCall) {
          this.onToolCallComplete({
            kind: 'error',
            result: 'Error: This exact action was already executed. Please try a different approach.',
            toolCallId: parsed.toolCallId,
            toolName: parsed.toolName as GhostbuildToolName,
          });
          return;
        }
        this.#previousToolCalls.set(key, { toolName: parsed.toolName, args: parsed.args });
      }
    }

    this.updateAction(actionId, { ...action, ...data.action, executed: !args.isStreaming });

    this.#currentExecutionPromise = this.#currentExecutionPromise
      .then(() => {
        return this.#executeAction(actionId, args);
      })
      .catch((error) => {
        logger.error('Action failed:', error);
      });

    await this.#currentExecutionPromise;
  }

  async #executeAction(actionId: string, args: { isStreaming: boolean }) {
    const action = this.actions.get()[actionId];

    this.updateAction(actionId, { status: 'running' });

    try {
      switch (action.type) {
        case 'file': {
          await this.#runFileAction(action);
          break;
        }
        case 'toolUse': {
          await this.#runToolUseAction(action);
          break;
        }
        default: {
          throw new Error(`Unknown action type: ${JSON.stringify(action)}`);
        }
      }

      this.updateAction(actionId, {
        status: args.isStreaming ? 'running' : action.abortSignal.aborted ? 'aborted' : 'complete',
      });
    } catch (error) {
      if (action.abortSignal.aborted) {
        return;
      }

      this.updateAction(actionId, { status: 'failed', error: 'Action failed' });
      logger.error(`[${action.type}]:Action failed\n\n`, error);

      if (!(error instanceof ActionCommandError)) {
        return;
      }

      this.onAlert?.({
        type: 'error',
        title: 'Command Failed',
        description: error.header,
        content: error.output,
      });

      // re-throw the error to be caught in the promise chain
      throw error;
    }
  }

  async #runFileAction(action: ActionState) {
    if (action.type !== 'file') {
      unreachable('Expected file action');
    }

    const webcontainer = await this.#webcontainer;
    const relativePath = nodePath.relative(webcontainer.workdir, action.filePath);

    assertNotLocalSecretFilePath(relativePath);

    const folder = nodePath.dirname(relativePath).replace(/\/+$/g, '');

    if (folder !== '.') {
      try {
        await webcontainer.fs.mkdir(folder, { recursive: true });
        logger.debug('Created folder', folder);
      } catch (error) {
        logger.error('Failed to create folder\n\n', error);
      }
    }

    try {
      assertValidGeneratedPackageJson(relativePath, action.content);
      await webcontainer.fs.writeFile(relativePath, action.content);
      logger.debug(`File written ${relativePath}`);
    } catch (error) {
      logger.error('Failed to write file\n\n', error);
      throw error;
    }
  }

  updateAction(id: string, newState: ActionStateUpdate) {
    const actions = this.actions.get();

    this.actions.setKey(id, { ...actions[id], ...newState });
  }

  async #runToolUseAction(action: ActionState) {
    if (action.type !== 'toolUse') {
      unreachable('Expected tool use action');
    }

    const parsed: GhostbuildToolInvocation = action.parsedContent;

    if (parsed.state === 'result') {
      return;
    }
    if (parsed.state === 'partial-call') {
      throw new Error('Tool call is still in progress');
    }

    let result: string;
    try {
      switch (parsed.toolName) {
        case 'view': {
          const args = viewParameters.parse(parsed.args);
          const container = await this.#webcontainer;
          const relPath = workDirRelative(args.path);
          const file = await readPath(container, relPath);
          if (file.type === 'directory') {
            result = renderDirectory(file.children);
            break;
          }

          if (args.view_range && args.view_range.length !== 2) {
            throw new Error('When provided, view_range must be an array of two numbers');
          }

          result = renderFile(file.content, args.view_range as [number, number]);
          break;
        }
        case 'edit': {
          const args = editToolParameters.parse(parsed.args);
          const container = await this.#webcontainer;
          const relPath = workDirRelative(args.path);
          assertNotLocalSecretFilePath(relPath);
          const file = await readPath(container, relPath);
          if (file.type !== 'file') {
            throw new Error('Expected a file');
          }
          let content = file.content;
          if (args.old.length > 1024) {
            throw new Error(`Old text must be less than 1024 characters: ${args.old}`);
          }
          if (args.new.length > 1024) {
            throw new Error(`New text must be less than 1024 characters: ${args.new}`);
          }
          const matchPos = content.indexOf(args.old);
          if (matchPos === -1) {
            throw new Error(`Old text not found: ${args.old}`);
          }
          const secondMatchPos = content.indexOf(args.old, matchPos + args.old.length);
          if (secondMatchPos !== -1) {
            throw new Error(`Old text found multiple times: ${args.old}`);
          }
          content = content.replace(args.old, args.new);
          assertValidGeneratedPackageJson(relPath, content);
          await container.fs.writeFile(relPath, content);
          result = `Successfully edited ${args.path}`;
          break;
        }
        case 'npmInstall': {
          try {
            const args = npmInstallToolParameters.parse(parsed.args);
            const container = await this.#webcontainer;
            await waitForContainerBootState(ContainerBootState.READY);
            const packages = splitPackageSpecs(args.packages);
            const installProc = await container.spawn('pnpm', ['add', ...packages]);
            action.abortSignal.addEventListener('abort', () => {
              installProc.kill();
            });
            const { output, exitCode } = await streamOutput(installProc, {
              onOutput: (output) => {
                this.terminalOutput.set(output);
              },
              debounceMs: 50,
            });
            const cleanedOutput = cleanBuildOutput(output);
            if (exitCode !== 0) {
              throw new Error(`pnpm add failed with exit code ${exitCode}: ${cleanedOutput}`);
            }
            result = cleanedOutput;
          } catch (error: unknown) {
            result = packageInstallErrorMessage(error);
          }
          break;
        }
        case 'lookupDocs': {
          const args = lookupDocsParameters.parse(parsed.args);
          const docsToLookup = args.docs;
          const results: string[] = [];

          for (const doc of docsToLookup) {
            if (!(doc in docs)) {
              throw new Error(`Could not find documentation for component: ${doc}. It may not yet be supported.`);
            }
            results.push(docs[doc as DocKey]);
          }

          result = results.join('\n\n');
          break;
        }
        case 'deploy': {
          const container = await this.#webcontainer;
          await waitForContainerBootState(ContainerBootState.READY);

          result = '';

          const commandErroredController = new AbortController();
          const abortSignal = AbortSignal.any([action.abortSignal, commandErroredController.signal]);

          /** Return a promise of output on success, throws an error containing output on failure. */
          const run = async (commandAndArgs: string[], onOutput?: (s: string) => void): Promise<string> => {
            const command = commandAndArgs.join(' ');
            logger.info('starting to run', command);
            const t0 = performance.now();
            const proc = await container.spawn(commandAndArgs[0], commandAndArgs.slice(1));
            const abortListener = () => {
              logger.info('aborting', commandAndArgs);
              proc.kill();
            };
            abortSignal.addEventListener('abort', abortListener);
            const { output, exitCode } = await streamOutput(proc, { onOutput, debounceMs: 50 });

            const cleanedOutput = cleanBuildOutput(output);
            const time = performance.now() - t0;
            logger.debug('finished', command, 'in', Math.round(time));
            if (exitCode !== 0) {
              // Kill all other commands
              commandErroredController.abort(command);
              // This command's output will be reported exclusively
              throw new Error(`${command} failed with exit code ${exitCode}: ${cleanedOutput}`);
            }
            abortSignal.removeEventListener('abort', abortListener);
            if (cleanedOutput.trim().length === 0) {
              return '';
            }
            return cleanedOutput + '\n\n';
          };

          const t0 = performance.now();
          result += await run(['pnpm', 'run', 'deploy'], (output) => {
            this.terminalOutput.set(output);
          });
          const time = performance.now() - t0;
          logger.info('deploy action finished in', time);

          break;
        }
        default: {
          throw new Error(`Unknown tool: ${parsed.toolName}`);
        }
      }
      this.onToolCallComplete({
        kind: 'success',
        result,
        toolCallId: action.parsedContent.toolCallId,
        toolName: parsed.toolName,
      });
    } catch (error) {
      logger.error('Error on tool call', error);
      let message = String(error);
      if (!message.startsWith('Error:')) {
        message = 'Error: ' + message;
      }
      this.onToolCallComplete({
        kind: 'error',
        result: message,
        toolCallId: action.parsedContent.toolCallId,
        toolName: parsed.toolName as GhostbuildToolName,
      });
      throw error;
    }
  }
}
