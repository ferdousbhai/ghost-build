import { isReadOnlyToolName } from 'ghostbuild-agent/types';

/**
 * Allows independent read-only tools to overlap while treating every mutation,
 * dependency operation, validation, and deployment as an exclusive barrier.
 */
export class ToolExecutionScheduler {
  #barrier = Promise.resolve();
  #activeReads = new Set<Promise<unknown>>();

  run<T>(toolName: string, execute: () => Promise<T>): Promise<T> {
    return isReadOnlyToolName(toolName) ? this.#runRead(execute) : this.#runExclusive(execute);
  }

  async #runRead<T>(execute: () => Promise<T>): Promise<T> {
    await this.#barrier;
    const operation = execute();
    this.#activeReads.add(operation);
    try {
      return await operation;
    } finally {
      this.#activeReads.delete(operation);
    }
  }

  async #runExclusive<T>(execute: () => Promise<T>): Promise<T> {
    const previousBarrier = this.#barrier;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#barrier = previousBarrier.then(() => held);
    try {
      await previousBarrier;
      await Promise.allSettled([...this.#activeReads]);
      return await execute();
    } finally {
      release();
    }
  }
}
