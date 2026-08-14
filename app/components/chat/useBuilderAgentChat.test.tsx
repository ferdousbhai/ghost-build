// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

type ChatCallbacks = {
  onData: (part: { type: string; data?: unknown }) => void;
  onError: (error: Error) => void;
  onFinish: (result: { finishReason: string; message: GhostbuildMessage }) => void;
};

const mocks = vi.hoisted(() => {
  const controller = { dispose: vi.fn(), pull: vi.fn() };
  const chat = {
    messages: [] as GhostbuildMessage[],
    status: 'ready' as const,
    isRecovering: false,
    isStreaming: false,
    setMessages: vi.fn(),
    sendMessage: vi.fn(),
    stop: vi.fn(),
  };
  const previewRequests: Array<() => Promise<unknown>> = [];
  const workbench = {
    connectPreview: vi.fn((actions: { request: () => Promise<unknown> }) => {
      previewRequests.push(actions.request);
      return vi.fn();
    }),
    updatePreview: vi.fn(),
  };
  return {
    agent: { state: {} as { transcript?: unknown }, call: vi.fn() },
    chat,
    chatCallbacks: [] as ChatCallbacks[],
    executeDataOperation: vi.fn(),
    finishToolTurn: vi.fn(),
    loadSnapshot: vi.fn(async (args: { read: () => Promise<unknown> }) => args.read()),
    recordChatFailure: vi.fn(),
    recordToolProgress: vi.fn(),
    reconcileMessages: vi.fn(async (args: { localMessages: GhostbuildMessage[] }) => args.localMessages),
    resetChatRetryState: vi.fn(),
    abortToolActivity: vi.fn(),
    clearToolProgress: vi.fn(),
    showCloudflareAiFundingRequiredToast: vi.fn(),
    showWorkersPaidRequiredToast: vi.fn(),
    controller,
    initializeWorkspace: vi.fn(async () => controller),
    previewRequests,
    replica: {} as object | undefined,
    waitForSocket: vi.fn(async () => undefined),
    workbench,
  };
});

vi.mock('@cloudflare/ai-chat/react', () => ({
  useAgentChat: (callbacks: ChatCallbacks) => {
    mocks.chatCallbacks.push(callbacks);
    return mocks.chat;
  },
}));
vi.mock('agents/react', () => ({ useAgent: () => mocks.agent }));
vi.mock('@nanostores/react', () => ({ useStore: (store: { get: () => unknown }) => store.get() }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('~/lib/cloudflare/account-local-replica', () => ({
  useAccountLocalReplica: () => mocks.replica,
}));
vi.mock('~/lib/cloudflare/runtime-session', () => ({
  requireUserRuntimeEndpoint: () => 'https://runtime.example.com',
}));
vi.mock('~/lib/stores/builder-workspace-sync.client', () => ({
  BuilderWorkspaceSyncController: { initialize: mocks.initializeWorkspace },
}));
vi.mock('~/lib/stores/workbench.client', () => ({ workbenchStore: mocks.workbench }));
vi.mock('./agent-connection', () => ({ waitForAgentSocketOpen: mocks.waitForSocket }));
vi.mock('./builder-agent-auth', () => ({
  BUILDER_AGENT_QUERY_CACHE_TTL_MS: 1_000,
  loadBuilderAgentCapability: vi.fn(),
}));
vi.mock('~/lib/telemetry.client', () => ({ captureMessage: vi.fn() }));
vi.mock('~/lib/cloudflare/chat-history-db', () => ({ refreshChatHistory: vi.fn() }));
vi.mock('~/lib/cloudflare/client', () => ({ executeDataOperation: mocks.executeDataOperation }));
vi.mock('~/lib/cloudflare/data-api', () => ({ api: { messages: { get: {} } } }));
vi.mock('~/lib/cloudflare/data-hooks', () => ({ subchatQueryKey: vi.fn(() => []) }));
vi.mock('~/lib/workers-paid.client', () => ({
  showCloudflareAiFundingRequiredToast: mocks.showCloudflareAiFundingRequiredToast,
  showWorkersPaidRequiredToast: mocks.showWorkersPaidRequiredToast,
}));
vi.mock('~/lib/stores/tool-activity.client', () => ({
  toolActivityStore: {
    abortActive: mocks.abortToolActivity,
    finishTurn: mocks.finishToolTurn,
  },
}));
vi.mock('~/lib/stores/tool-progress.client', () => ({
  toolProgressStore: {
    clear: mocks.clearToolProgress,
    record: mocks.recordToolProgress,
  },
}));
vi.mock('./chat-retry', () => ({
  recordChatFailure: mocks.recordChatFailure,
  resetChatRetryState: mocks.resetChatRetryState,
}));
vi.mock('./chat-send-reconciliation', () => ({
  loadAuthoritativeTranscriptSnapshot: mocks.loadSnapshot,
  reconcileMessagesForSend: mocks.reconcileMessages,
}));

import { useBuilderAgentChat } from './useBuilderAgentChat';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.agent.call.mockReset();
  mocks.agent.state = {};
  mocks.replica = {};
  mocks.initializeWorkspace.mockClear();
  mocks.controller.dispose.mockClear();
  mocks.controller.pull.mockClear();
  mocks.chat.messages = [];
  mocks.chat.sendMessage.mockClear();
  mocks.chat.setMessages.mockClear();
  mocks.chatCallbacks.length = 0;
  mocks.executeDataOperation.mockReset();
  mocks.finishToolTurn.mockClear();
  mocks.loadSnapshot.mockReset();
  mocks.loadSnapshot.mockImplementation(async (args: { read: () => Promise<unknown> }) => args.read());
  mocks.recordChatFailure.mockClear();
  mocks.recordToolProgress.mockClear();
  mocks.reconcileMessages.mockReset();
  mocks.reconcileMessages.mockImplementation(
    async (args: { localMessages: GhostbuildMessage[] }) => args.localMessages,
  );
  mocks.resetChatRetryState.mockClear();
  mocks.abortToolActivity.mockClear();
  mocks.clearToolProgress.mockClear();
  mocks.showCloudflareAiFundingRequiredToast.mockClear();
  mocks.showWorkersPaidRequiredToast.mockClear();
  mocks.previewRequests.length = 0;
  mocks.waitForSocket.mockReset();
  mocks.waitForSocket.mockResolvedValue(undefined);
  mocks.workbench.connectPreview.mockClear();
  mocks.workbench.updatePreview.mockClear();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

describe('useBuilderAgentChat workspace preparation', () => {
  it('preserves pending send admission when the replica becomes ready for the same presentation', async () => {
    mocks.replica = undefined;
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      if (method === 'getTranscriptSnapshot') {
        return { checkpoint: null, messages: [] };
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    let currentChat: ReturnType<typeof useBuilderAgentChat> | undefined;
    function Harness() {
      currentChat = useBuilderAgentChat(chatArgs('workspace-1'));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    const pendingSend = settle(currentChat!.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'build it' }] }));

    await Promise.resolve();
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
    expect(prepareWorkspaceCalls()).toHaveLength(0);

    mocks.replica = {};
    await act(async () => root?.render(<Harness />));

    await expect(pendingSend).resolves.toBeNull();
    expect(prepareWorkspaceCalls()).toHaveLength(1);
    expect(mocks.chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('settles the unstarted readiness gate when the presentation switches while the replica opens', async () => {
    mocks.replica = undefined;
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    let currentChat: ReturnType<typeof useBuilderAgentChat> | undefined;
    function Harness({ presentationId }: { presentationId: string }) {
      currentChat = useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    const staleSend = settle(currentChat!.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'build it' }] }));

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));

    await expect(staleSend).resolves.toEqual(
      expect.objectContaining({ message: 'The durable workspace initialization was superseded.' }),
    );
    expect(prepareWorkspaceCalls()).toHaveLength(0);
  });

  it('settles stale send admission without activating the old workspace when the presentation switches', async () => {
    const oldPreparation = deferred<{ initialized: boolean }>();
    const newPreparation = deferred<{ initialized: boolean }>();
    const preparations = [oldPreparation.promise, newPreparation.promise];
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        const preparation = preparations.shift();
        if (!preparation) {
          throw new Error('Unexpected workspace preparation');
        }
        return preparation;
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    let currentChat: ReturnType<typeof useBuilderAgentChat> | undefined;
    function Harness({ presentationId }: { presentationId: string }) {
      currentChat = useBuilderAgentChat(chatArgs(presentationId));
      return <span>{currentChat.workspacePresentationState}</span>;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));

    const staleSend = currentChat!.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'build it' }] }).then(
      () => null,
      (error: unknown) => error,
    );

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(2));
    await expect(staleSend).resolves.toEqual(
      expect.objectContaining({ message: 'The durable workspace initialization was superseded.' }),
    );

    await act(async () => oldPreparation.resolve({ initialized: true }));
    expect(mocks.initializeWorkspace).not.toHaveBeenCalled();

    await act(async () => newPreparation.resolve({ initialized: true }));
    await vi.waitFor(() =>
      expect(mocks.initializeWorkspace).toHaveBeenCalledWith(
        mocks.agent,
        expect.objectContaining({ workspaceId: 'workspace-new' }),
      ),
    );
    expect(mocks.initializeWorkspace).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('ready');
  });
});

describe('useBuilderAgentChat stale presentation operations', () => {
  it('ignores stream callbacks retained by a superseded presentation', async () => {
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    function Harness({ presentationId }: { presentationId: string }) {
      useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));
    const staleCallbacks = mocks.chatCallbacks.at(-1)!;

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(2));
    mocks.controller.pull.mockClear();

    staleCallbacks.onData({
      type: 'data-tool-progress',
      data: { toolCallId: 'tool-1', toolName: 'write', result: 'done' },
    });
    staleCallbacks.onError(new Error('stale failure'));
    staleCallbacks.onFinish({
      finishReason: 'stop',
      message: { id: 'assistant-1', role: 'assistant', parts: [] },
    });
    await Promise.resolve();

    expect(mocks.recordToolProgress).not.toHaveBeenCalled();
    expect(mocks.clearToolProgress).not.toHaveBeenCalled();
    expect(mocks.abortToolActivity).not.toHaveBeenCalled();
    expect(mocks.finishToolTurn).not.toHaveBeenCalled();
    expect(mocks.recordChatFailure).not.toHaveBeenCalled();
    expect(mocks.resetChatRetryState).not.toHaveBeenCalled();
    expect(mocks.showCloudflareAiFundingRequiredToast).not.toHaveBeenCalled();
    expect(mocks.showWorkersPaidRequiredToast).not.toHaveBeenCalled();
    expect(mocks.executeDataOperation).not.toHaveBeenCalled();
    expect(mocks.controller.pull).not.toHaveBeenCalled();
  });

  it('does not apply terminal transcript reconciliation after the presentation switches', async () => {
    const checkpoint = {
      agentName: 'agent-1',
      generation: 1,
      subchatIndex: 0,
      digest: 'a'.repeat(64),
      messageCount: 1,
      revision: 1,
    };
    const localMessages: GhostbuildMessage[] = [
      { id: 'local-1', role: 'user', parts: [{ type: 'text', text: 'local' }] },
    ];
    const durableMessages: GhostbuildMessage[] = [
      { id: 'durable-1', role: 'user', parts: [{ type: 'text', text: 'durable' }] },
    ];
    const reconciliation = deferred<GhostbuildMessage[]>();
    mocks.chat.messages = localMessages;
    mocks.agent.state = { transcript: checkpoint };
    mocks.reconcileMessages.mockImplementationOnce(async () => reconciliation.promise);
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      if (method === 'getTranscriptSnapshot') {
        return { checkpoint, messages: durableMessages };
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    function Harness({ presentationId }: { presentationId: string }) {
      useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(mocks.reconcileMessages).toHaveBeenCalledTimes(1));

    mocks.agent.state = {};
    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await act(async () => reconciliation.resolve(durableMessages));

    expect(mocks.chat.setMessages).not.toHaveBeenCalled();
  });

  it('does not send after the presentation switches during transcript reconciliation', async () => {
    const oldSnapshot = deferred<{ checkpoint: null; messages: GhostbuildMessage[] }>();
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      if (method === 'getTranscriptSnapshot') {
        return oldSnapshot.promise;
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    let currentChat: ReturnType<typeof useBuilderAgentChat> | undefined;
    function Harness({ presentationId }: { presentationId: string }) {
      currentChat = useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));

    const staleSend = settle(currentChat!.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'build it' }] }));
    await vi.waitFor(() => expect(transcriptSnapshotCalls()).toHaveLength(1));

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await act(async () => oldSnapshot.resolve({ checkpoint: null, messages: [] }));

    await expect(staleSend).resolves.toEqual(
      expect.objectContaining({ message: 'The durable workspace initialization was superseded.' }),
    );
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
  });

  it('does not steer after the presentation switches while the socket becomes ready', async () => {
    const oldSendSocket = deferred<void>();
    let socketCall = 0;
    mocks.waitForSocket.mockImplementation(async () => {
      socketCall += 1;
      if (socketCall === 2) {
        await oldSendSocket.promise;
      }
    });
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      if (method === 'steerActiveTurn') {
        return undefined;
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    let currentChat: ReturnType<typeof useBuilderAgentChat> | undefined;
    function Harness({ presentationId }: { presentationId: string }) {
      currentChat = useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));

    const staleSteer = settle(currentChat!.steerMessage({ text: 'change course' }));
    await vi.waitFor(() => expect(mocks.waitForSocket).toHaveBeenCalledTimes(2));

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await act(async () => oldSendSocket.resolve());

    await expect(staleSteer).resolves.toEqual(
      expect.objectContaining({ message: 'The durable workspace initialization was superseded.' }),
    );
    expect(mocks.agent.call.mock.calls.filter(([method]) => method === 'steerActiveTurn')).toHaveLength(0);
  });

  it('ignores preview get and request responses from a superseded presentation', async () => {
    const oldGet = deferred<{ presentation: string }>();
    const oldRequest = deferred<{ presentation: string }>();
    let getCall = 0;
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        getCall += 1;
        return getCall === 1 ? oldGet.promise : { presentation: 'new' };
      }
      if (method === 'requestPreview') {
        return oldRequest.promise;
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    function Harness({ presentationId }: { presentationId: string }) {
      useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(mocks.previewRequests).toHaveLength(1));
    const staleRequest = mocks.previewRequests[0]();

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await vi.waitFor(() => expect(mocks.previewRequests).toHaveLength(2));
    await act(async () => {
      oldGet.resolve({ presentation: 'old-get' });
      oldRequest.resolve({ presentation: 'old-request' });
      await Promise.all([oldGet.promise, staleRequest]);
    });

    expect(mocks.workbench.updatePreview).toHaveBeenCalledWith({ presentation: 'new' });
    expect(mocks.workbench.updatePreview).not.toHaveBeenCalledWith({ presentation: 'old-get' });
    expect(mocks.workbench.updatePreview).not.toHaveBeenCalledWith({ presentation: 'old-request' });
  });
});

function chatArgs(presentationId: string) {
  return {
    accountId: 'account-1',
    chatInitialId: 'chat-1',
    initialMessages: [],
    onSubchatTitle: vi.fn(),
    presentationId,
    transcript: { agentName: 'agent-1', generation: 1, subchatIndex: 0 },
  };
}

function prepareWorkspaceCalls() {
  return mocks.agent.call.mock.calls.filter(([method]) => method === 'prepareWorkspace');
}

function transcriptSnapshotCalls() {
  return mocks.agent.call.mock.calls.filter(([method]) => method === 'getTranscriptSnapshot');
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
