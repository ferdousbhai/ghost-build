type CommandTerminationRuntime = {
  killExec(id: string, options: { backend: string; signal: 'SIGKILL' }): Promise<void>;
  getExec(
    id: string,
    options: { backend: string; encoding: 'utf8'; resume: 'tail' },
  ): Promise<{ result(): Promise<unknown>; [Symbol.dispose](): void }>;
};

/** Force-stop a command and do not settle until its terminal result can be observed. */
export async function terminateWorkspaceCommand(
  runtime: CommandTerminationRuntime,
  id: string,
  backend: 'container-shell',
  retryDelay: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1_000)),
): Promise<void> {
  while (true) {
    await runtime.killExec(id, { backend, signal: 'SIGKILL' }).catch(() => undefined);
    let observer: Awaited<ReturnType<CommandTerminationRuntime['getExec']>> | undefined;
    let terminated = false;
    try {
      observer = await runtime.getExec(id, { backend, encoding: 'utf8', resume: 'tail' });
      await observer.result();
      terminated = true;
    } catch {
      // Retry until terminal observation succeeds; early settlement is unsafe.
    } finally {
      observer?.[Symbol.dispose]();
    }
    if (terminated) {
      return;
    }
    await retryDelay();
  }
}
