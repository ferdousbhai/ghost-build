const AGENT_SOCKET_OPEN_TIMEOUT_MS = 30_000;
const AGENT_CONNECT_ERROR_MESSAGE = 'Ghostbuild could not connect to the builder. Please try again.';
const AGENT_CONNECTION_LOST_MESSAGE = 'Ghostbuild lost its builder connection. Please try again.';

export type AgentSocketLike = {
  OPEN?: number;
  identified?: boolean;
  ready?: Promise<unknown>;
  readyState?: number;
  connectionError?: Error | null;
  addEventListener?(type: 'open' | 'close' | 'error', listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener?(type: 'open' | 'close' | 'error', listener: EventListener): void;
};

export async function waitForAgentSocketOpen(
  agent: AgentSocketLike,
  timeoutMs = AGENT_SOCKET_OPEN_TIMEOUT_MS,
  options: { requireIdentity?: boolean } = {},
): Promise<void> {
  const requireIdentity = options.requireIdentity ?? true;
  if (agent.connectionError) {
    throw agent.connectionError;
  }

  const startedAt = Date.now();
  const remainingTimeoutMs = () => Math.max(0, timeoutMs - (Date.now() - startedAt));

  if (typeof agent.readyState !== 'number') {
    if (requireIdentity && !isAgentIdentified(agent)) {
      await waitForAgentIdentity(agent, remainingTimeoutMs());
    }
    return;
  }

  const openReadyState = typeof agent.OPEN === 'number' ? agent.OPEN : 1;
  if (agent.readyState !== openReadyState) {
    if (!agent.addEventListener || !agent.removeEventListener) {
      if (requireIdentity) {
        await waitForAgentIdentity(agent, remainingTimeoutMs());
      }
      return;
    }

    await waitForSocketOpen(agent, remainingTimeoutMs());
  }

  if (agent.connectionError) {
    throw agent.connectionError;
  }

  if (!requireIdentity || isAgentIdentified(agent)) {
    return;
  }

  await waitForAgentIdentity(agent, remainingTimeoutMs());
}

function isAgentIdentified(agent: AgentSocketLike): boolean {
  return agent.identified === true;
}

function waitForAgentIdentity(agent: AgentSocketLike, timeoutMs: number): Promise<void> {
  if (!agent.ready) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(AGENT_CONNECT_ERROR_MESSAGE));
    }, timeoutMs);

    agent.ready?.then(
      () => {
        clearTimeout(timeoutId);
        resolve();
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function waitForSocketOpen(agent: AgentSocketLike, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      agent.removeEventListener?.('open', onOpen);
      agent.removeEventListener?.('close', onClose);
      agent.removeEventListener?.('error', onError);
    };
    const finish = (callback: () => void) => {
      cleanup();
      callback();
    };
    const onOpen = () => finish(resolve);
    const onClose = () => finish(() => reject(new Error(AGENT_CONNECTION_LOST_MESSAGE)));
    const onError = () => finish(() => reject(new Error(AGENT_CONNECT_ERROR_MESSAGE)));

    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error(AGENT_CONNECT_ERROR_MESSAGE)));
    }, timeoutMs);
    agent.addEventListener?.('open', onOpen);
    agent.addEventListener?.('close', onClose);
    agent.addEventListener?.('error', onError);
    const openReadyState = typeof agent.OPEN === 'number' ? agent.OPEN : 1;
    if (agent.readyState === openReadyState) {
      onOpen();
    }
  });
}
