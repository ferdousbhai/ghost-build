import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { cleanTerminalOutput } from 'ghostbuild-agent/utils/shell';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { ITerminal } from '~/types/terminal';
import { assertProductionShellCommandAllowed } from '~/utils/productionShellPolicy';
import { spawnInteractiveJsh, wireInteractiveTerminal } from './interactive-terminal';
import { appendProcessOutputTail } from './process';

const logger = createScopedLogger('GhostbuildShell');
type ExecutionResult = { output: string; exitCode: number };
type OutputWaiter = {
  output: string;
  resolve: (result: ExecutionResult) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
};

const SHELL_INITIALIZATION_TIMEOUT_MS = 30_000;
const SHELL_COMMAND_TIMEOUT_MS = 180_000;

class GhostbuildShell {
  #initialized: (() => void) | undefined;
  #readyPromise: Promise<void>;
  #terminal: ITerminal | undefined;
  #process: WebContainerProcess | undefined;
  #shellInputStream: WritableStreamDefaultWriter<string> | undefined;
  #outputWaiters = new Map<string, Set<OutputWaiter>>();
  #oscBuffer = '';

  constructor() {
    this.#readyPromise = new Promise((resolve) => {
      this.#initialized = resolve;
    });
  }

  ready(): Promise<void> {
    return this.#readyPromise;
  }

  async init(webcontainer: WebContainer, terminal: ITerminal): Promise<void> {
    this.#terminal = terminal;
    const { process, output } = await this.#createShellProcess(webcontainer, terminal);
    this.#process = process;
    const interactive = this.waitTillOscCode('interactive', SHELL_INITIALIZATION_TIMEOUT_MS);
    void this.#monitorOutput(output.getReader());
    await interactive;
    this.#initialized?.();
  }

  get terminal(): ITerminal | undefined {
    return this.#terminal;
  }

  get process(): WebContainerProcess | undefined {
    return this.#process;
  }

  async interrupt(options: { timeoutMs?: number } = {}): Promise<void> {
    if (!this.#shellInputStream) {
      return;
    }
    const prompt = this.waitTillOscCode('prompt', options.timeoutMs ?? 10_000);
    await this.#shellInputStream.write('\x03');
    await prompt;
  }

  async startCommand(command: string, options?: { allowLocalDevServer?: boolean }): Promise<void> {
    if (!this.process || !this.terminal) {
      throw new Error('Terminal not initialized');
    }
    if (!options?.allowLocalDevServer) {
      assertProductionShellCommandAllowed(command);
    }
    if (!this.#shellInputStream) {
      throw new Error('Shell input stream not initialized');
    }
    await this.interrupt();
    await this.#shellInputStream.write(`${command.trim()}\n`);
  }

  async executeCommand(command: string, options: { timeoutMs?: number } = {}): Promise<ExecutionResult> {
    if (!this.process || !this.terminal || !this.#shellInputStream) {
      throw new Error('Terminal not initialized');
    }
    assertProductionShellCommandAllowed(command);
    await this.interrupt();
    const completed = this.waitTillOscCode('exit', options.timeoutMs ?? SHELL_COMMAND_TIMEOUT_MS);
    await this.#shellInputStream.write(`${command.trim()}\n`);
    let result: ExecutionResult;
    try {
      result = await completed;
    } catch (error) {
      await this.interrupt().catch((interruptError) =>
        logger.debug('Failed to interrupt timed out command', interruptError),
      );
      throw error;
    }
    const { output, exitCode } = result;
    try {
      return { output: cleanTerminalOutput(output), exitCode };
    } catch (error) {
      logger.debug('Failed to format terminal output', error);
      return { output, exitCode };
    }
  }

  waitTillOscCode(waitCode: string, timeoutMs?: number): Promise<ExecutionResult> {
    return new Promise((resolve, reject) => {
      const waiter: OutputWaiter = { output: '', resolve, reject };
      let waiters = this.#outputWaiters.get(waitCode);
      if (!waiters) {
        waiters = new Set();
        this.#outputWaiters.set(waitCode, waiters);
      }
      waiters.add(waiter);
      if (timeoutMs !== undefined) {
        waiter.timeoutId = setTimeout(() => {
          this.#removeWaiter(waitCode, waiter);
          reject(new Error(`Timed out waiting for shell ${waitCode} after ${timeoutMs} ms.`));
        }, timeoutMs);
      }
    });
  }

  async #monitorOutput(reader: ReadableStreamDefaultReader<string>): Promise<void> {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        this.#handleOutput(value || '');
      }
    } catch (error) {
      logger.error('Shell output stream failed', error);
    } finally {
      for (const [waitCode, waiters] of this.#outputWaiters) {
        for (const waiter of waiters) {
          this.#removeWaiter(waitCode, waiter);
          waiter.reject(new Error(`Shell output ended before ${waitCode}.`));
        }
      }
    }
  }

  #handleOutput(text: string): void {
    for (const waiters of this.#outputWaiters.values()) {
      for (const waiter of waiters) {
        waiter.output = appendProcessOutputTail(waiter.output, text);
      }
    }

    this.#oscBuffer = `${this.#oscBuffer}${text}`.slice(-4096);
    const oscPattern = /\x1b\]654;([^\x07=]+)=?((-?\d+):(\d+))?\x07/g;
    for (const match of this.#oscBuffer.matchAll(oscPattern)) {
      const waitCode = match[1];
      const waiters = this.#outputWaiters.get(waitCode);
      if (!waiters) {
        continue;
      }
      const exitCode = waitCode === 'exit' ? Number.parseInt(match[4], 10) || 0 : 0;
      for (const waiter of [...waiters]) {
        this.#removeWaiter(waitCode, waiter);
        waiter.resolve({ output: waiter.output, exitCode });
      }
    }
    const lastTerminator = this.#oscBuffer.lastIndexOf('\x07');
    if (lastTerminator >= 0) {
      this.#oscBuffer = this.#oscBuffer.slice(lastTerminator + 1);
    }
  }

  #removeWaiter(waitCode: string, waiter: OutputWaiter): void {
    if (waiter.timeoutId !== undefined) {
      clearTimeout(waiter.timeoutId);
    }
    const waiters = this.#outputWaiters.get(waitCode);
    waiters?.delete(waiter);
    if (waiters?.size === 0) {
      this.#outputWaiters.delete(waitCode);
    }
  }

  async #createShellProcess(webcontainer: WebContainer, terminal: ITerminal) {
    const { process, input, output } = await spawnInteractiveJsh(webcontainer, terminal);
    this.#shellInputStream = input;
    const [internalOutput, terminalOutput] = output.tee();
    await wireInteractiveTerminal({ input, output: terminalOutput, terminal });
    return { process, output: internalOutput };
  }
}

export function newGhostbuildShellProcess(): GhostbuildShell {
  return new GhostbuildShell();
}
