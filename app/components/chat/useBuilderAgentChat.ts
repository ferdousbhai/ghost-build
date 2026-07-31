import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAgent } from 'agents/react';
import type { UIMessage } from 'ai';
import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BuilderAgent, BuilderAgentState } from '~/agents/builder-agent';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { getAuthToken, sessionIdStore, useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { captureMessage } from '~/lib/telemetry.client';
import { ChatContextManager } from 'ghostbuild-agent/ChatContextManager';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { STATUS_MESSAGES } from './StreamingIndicator';
import { recordChatFailure, resetChatRetryState } from './chat-retry';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { waitForAgentSocketOpen } from './agent-connection';
import { WORKERS_PAID_REQUIRED_MARKER } from '~/lib/workers-paid';
import { showWorkersPaidRequiredToast } from '~/lib/workers-paid.client';
import { refreshChatHistory } from '~/lib/cloudflare/chat-history-db';
import { chatIdStore } from '~/lib/stores/chatId';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { description as descriptionStore } from '~/lib/stores/description';
import {
  transcriptCheckpointMatchesMessages,
  transcriptCheckpointSchema,
  transcriptIdentitiesEqual,
  stripTranscriptBaseMetadata,
  TRANSCRIPT_BASE_METADATA_KEY,
  type TranscriptIdentity,
} from 'ghostbuild-agent/transcript';
import { BuilderWorkspaceSyncController } from '~/lib/stores/builder-workspace-sync.client';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { useQueryClient } from '@tanstack/react-query';
import { subchatQueryKey } from '~/lib/cloudflare/data-hooks';
import { settleBuilderStop } from './builder-stop';
import { useAccountLocalReplica } from '~/lib/cloudflare/account-local-replica';

const logger = createScopedLogger('BuilderAgentChat');
const AGENT_SEND_READY_TIMEOUT_MS = 10_000;
const AGENT_CANCEL_SETTLE_TIMEOUT_MS = 5 * 60 * 1000;

export function useBuilderAgentChat(args: {
  chatInitialId: string;
  initialMessages: GhostbuildMessage[];
  onSubchatTitle: (subchatIndex: number, title: string) => void;
  transcript: TranscriptIdentity;
  seedTranscript: boolean;
}) {
  const currentSubchatIndex = useStore(subchatIndexStore);
  const sessionId = useSessionIdOrNullOrLoading();
  const workspaceReplica = useAccountLocalReplica(sessionId);
  const [workspacePresentationState, setWorkspacePresentationState] = useState<
    'connecting' | 'ready' | 'presentation-error'
  >('connecting');
  const queryClient = useQueryClient();
  const generatedSubchatTitleUpdatedAtRef = useRef<string | null>(null);
  const contextManager = useRef(
    new ChatContextManager(
      () => workbenchStore.currentDocument.get(),
      () => workbenchStore.files.get(),
      () => workbenchStore.userWrites,
    ),
  );
  const builderAgent = useAgent<BuilderAgent, BuilderAgentState>({
    agent: 'BuilderAgent',
    name: args.transcript.agentName,
    onStateUpdate: (state) => {
      if (state.preview) {
        workbenchStore.updatePreview(state.preview);
      }
      const generatedTitle = state.generatedSubchatTitle;
      if (!generatedTitle || generatedSubchatTitleUpdatedAtRef.current === generatedTitle.updatedAt) {
        return;
      }
      generatedSubchatTitleUpdatedAtRef.current = generatedTitle.updatedAt;
      args.onSubchatTitle(generatedTitle.subchatIndex, generatedTitle.title);
      const sessionId = sessionIdStore.get();
      const chatId = chatIdStore.get();
      if (typeof sessionId === 'string' && chatId) {
        void queryClient.invalidateQueries({
          queryKey: subchatQueryKey({ chatId, sessionId }),
        });
      }
    },
  });
  const workspaceControllerRef = useRef<BuilderWorkspaceSyncController | null>(null);
  const workspaceKey = args.transcript.agentName;
  const workspaceGateRef = useAsyncGate(workspaceKey);
  const chat = useAgentChat<BuilderAgentState, UIMessage>({
    agent: builderAgent,
    getInitialMessages: null,
    messages: args.initialMessages as UIMessage[],
    syncMessagesToServer: false,
    experimental_throttle: 100,
    prepareSendMessagesRequest: ({ body }) => {
      if (!getAuthToken()) {
        throw new Error('No token');
      }
      return {
        body: {
          ...body,
          chatInitialId: args.chatInitialId,
          subchatIndex: subchatIndexStore.get() ?? 0,
          transcript: args.transcript,
        },
      };
    },
    autoContinueAfterToolResult: true,
    onError: (error: Error) => {
      captureMessage('Failed to process chat request', { level: 'error' });
      logger.error('Chat request failed', error);
      recordChatFailure(error.message.includes(STATUS_MESSAGES.error));
      toolActivityStore.abortActive();
      if (error.message.includes(WORKERS_PAID_REQUIRED_MARKER)) {
        showWorkersPaidRequiredToast();
      }
      void refreshProjectMetadata();
    },
    onFinish: ({ finishReason }) => {
      if (finishReason === 'stop') {
        resetChatRetryState();
      }
      logger.debug('Finished streaming');
      void workspaceControllerRef.current?.pull().catch((workspaceError) => {
        logger.error('Failed to refresh the durable workspace presentation after a builder response', workspaceError);
      });
      void refreshProjectMetadata();
    },
  });
  const setMessagesRef = useRef(chat.setMessages);
  const stopBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const initialMessagesRef = useRef(args.initialMessages);
  setMessagesRef.current = chat.setMessages;
  initialMessagesRef.current = args.initialMessages;
  const seedKey = args.seedTranscript
    ? `${args.transcript.agentName}:${args.transcript.generation}:${args.transcript.subchatIndex}`
    : null;
  const seedGateRef = useAsyncGate(seedKey);

  useEffect(() => {
    let disposed = false;
    const callPreview = async (method: 'getPreviewState' | 'requestPreview' | 'cancelPreview') => {
      const state = (await builderAgent.call(method, [], {
        timeout: method === 'getPreviewState' ? 10_000 : 30_000,
      })) as NonNullable<BuilderAgentState['preview']>;
      if (!disposed) {
        workbenchStore.updatePreview(state);
      }
      return state;
    };
    const disconnect = workbenchStore.connectPreview({
      refresh: () => callPreview('getPreviewState'),
      request: () => callPreview('requestPreview'),
      cancel: () => callPreview('cancelPreview'),
    });
    void callPreview('getPreviewState').catch((error) => logger.warn('Unable to load remote preview state', error));
    return () => {
      disposed = true;
      disconnect();
    };
  }, [builderAgent]);

  useEffect(() => {
    if (!seedKey) {
      return;
    }
    const gate = seedGateRef.current;
    if (gate.started) {
      return;
    }
    gate.started = true;
    void (async () => {
      try {
        await waitForAgentSocketOpen(builderAgent, AGENT_SEND_READY_TIMEOUT_MS, { requireIdentity: false });
        await builderAgent.call('seedTranscript', [args.transcript, args.initialMessages]);
        if (seedGateRef.current === gate) {
          setMessagesRef.current(initialMessagesRef.current as UIMessage[]);
        }
      } catch (error) {
        gate.error = error;
        logger.error('Failed to seed materialized transcript history', error);
      } finally {
        gate.resolve();
      }
    })();
  }, [args.initialMessages, args.transcript, builderAgent, seedGateRef, seedKey]);

  useEffect(() => {
    if (workspaceReplica === undefined) {
      return () => undefined;
    }
    const gate = workspaceGateRef.current;
    if (gate.key !== workspaceKey || gate.started) {
      return () => undefined;
    }
    gate.started = true;
    gate.error = null;
    let disposed = false;
    let sendGateResolved = false;
    let activeController: BuilderWorkspaceSyncController | null = null;
    void (async () => {
      try {
        await waitForAgentSocketOpen(builderAgent, AGENT_SEND_READY_TIMEOUT_MS, { requireIdentity: false });
        const state = (await builderAgent.call('prepareWorkspace', [])) as { initialized?: boolean };
        if (!state.initialized) {
          throw new Error('The durable project workspace was not initialized.');
        }
        if (!disposed && workspaceGateRef.current === gate) {
          sendGateResolved = true;
          gate.resolve();
        }
        const controller = await BuilderWorkspaceSyncController.initialize(builderAgent as never, {
          workspaceId: workspaceKey,
          replica: workspaceReplica,
        });
        if (disposed || workspaceGateRef.current !== gate) {
          controller.dispose();
          return;
        }
        workspaceControllerRef.current?.dispose();
        activeController = controller;
        workspaceControllerRef.current = controller;
        setWorkspacePresentationState('ready');
      } catch (workspaceError) {
        if (!disposed && workspaceGateRef.current === gate) {
          if (!sendGateResolved) {
            gate.error = workspaceError;
          }
          logger.error(
            sendGateResolved
              ? 'Failed to load the durable project workspace into the browser presentation cache'
              : 'Failed to initialize the durable project workspace',
            workspaceError,
          );
          if (sendGateResolved) {
            setWorkspacePresentationState('presentation-error');
          }
        }
      } finally {
        if (!disposed && workspaceGateRef.current === gate && !sendGateResolved) {
          gate.resolve();
        }
      }
    })();
    return () => {
      disposed = true;
      activeController?.dispose();
      gate.started = false;
      if (workspaceControllerRef.current === activeController) {
        workspaceControllerRef.current = null;
      }
    };
  }, [builderAgent, workspaceGateRef, workspaceKey, workspaceReplica]);

  const sendMessage = useCallback(
    async (
      message: Parameters<typeof chat.sendMessage>[0],
      options?: Parameters<typeof chat.sendMessage>[1],
      onRequestStart?: () => void,
    ) => {
      const gate = seedGateRef.current;
      const workspaceGate = workspaceGateRef.current;
      await Promise.all([gate.promise, workspaceGate.promise, stopBarrierRef.current]);
      if (gate.error || workspaceGate.error) {
        throw gate.error ?? workspaceGate.error;
      }
      try {
        await waitForAgentSocketOpen(builderAgent, AGENT_SEND_READY_TIMEOUT_MS, { requireIdentity: false });
      } catch (error) {
        logger.warn('Builder connection was not ready before send', error);
        captureMessage('Builder connection was not ready before send', {
          level: 'error',
        });
        throw error;
      }
      if (message && typeof message === 'object') {
        const checkpointResult = transcriptCheckpointSchema.nullable().safeParse(
          await builderAgent.call('getTranscriptCheckpoint', [args.transcript], {
            timeout: AGENT_SEND_READY_TIMEOUT_MS,
          }),
        );
        if (!checkpointResult.success) {
          throw new Error('The agent returned an invalid transcript checkpoint. Reload and try again.');
        }
        const checkpoint = checkpointResult.data;
        const localMessages = chat.messages as GhostbuildMessage[];
        if (!(await transcriptCheckpointMatchesMessages(checkpoint, localMessages))) {
          throw new Error('This chat changed in another session. Reload the latest messages before sending.');
        }
        const metadata =
          'metadata' in message &&
          message.metadata &&
          typeof message.metadata === 'object' &&
          !Array.isArray(message.metadata)
            ? message.metadata
            : {};
        try {
          const request = chat.sendMessage(
            {
              ...message,
              metadata: { ...metadata, [TRANSCRIPT_BASE_METADATA_KEY]: checkpoint },
            },
            options,
          );
          onRequestStart?.();
          return await request;
        } finally {
          setMessagesRef.current((messages) => messages.map(stripTranscriptBaseMetadata));
        }
      }
      const request = chat.sendMessage(message, options);
      onRequestStart?.();
      return request;
    },
    [args.transcript, builderAgent, chat, seedGateRef, workspaceGateRef],
  );

  const stop = useCallback(() => {
    chat.stop();
    toolActivityStore.abortActive();
    const cancellation = settleBuilderStop({
      cancel: () => builderAgent.call('cancelActiveTurn', [], { timeout: AGENT_CANCEL_SETTLE_TIMEOUT_MS }),
      reconcileMessages: (messages) => setMessagesRef.current(messages as UIMessage[]),
      refreshWorkspace: async () => {
        await workspaceControllerRef.current?.pull();
      },
    })
      .then(() => undefined)
      .catch((error) => {
        logger.error('Failed to durably cancel and reconcile the active builder turn', error);
        throw error;
      });
    stopBarrierRef.current = cancellation;
    void cancellation.catch(() => undefined);
  }, [builderAgent, chat]);

  useEffect(() => {
    setMessagesRef.current(initialMessagesRef.current as UIMessage[]);
    contextManager.current.reset();
  }, [currentSubchatIndex]);

  return {
    ...chat,
    stop,
    sendMessage,
    messages: chat.messages as GhostbuildMessage[],
    contextManager: contextManager.current,
    streamStatus: chat.isRecovering ? ('submitted' as const) : chat.isStreaming ? ('streaming' as const) : chat.status,
    transcriptCheckpoint:
      builderAgent.state?.transcript && transcriptIdentitiesEqual(builderAgent.state.transcript, args.transcript)
        ? builderAgent.state.transcript
        : null,
    workspacePresentationState,
  };
}

type AsyncGate = {
  key: string | null;
  promise: Promise<void>;
  resolve: () => void;
  error: unknown;
  started: boolean;
};

function useAsyncGate(key: string | null): { current: AsyncGate } {
  const gateRef = useRef<AsyncGate | null>(null);
  if (gateRef.current?.key !== key) {
    gateRef.current = createAsyncGate(key);
  }
  return gateRef as { current: AsyncGate };
}

function createAsyncGate(key: string | null): AsyncGate {
  if (key === null) {
    return {
      key,
      promise: Promise.resolve(),
      resolve: () => undefined,
      error: null,
      started: false,
    };
  }
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { key, promise, resolve, error: null, started: false };
}

async function refreshProjectMetadata(attempt = 0): Promise<void> {
  const sessionId = sessionIdStore.get();
  const chatId = chatIdStore.get();
  if (typeof sessionId !== 'string' || !chatId) {
    return;
  }
  try {
    const [, chat] = await Promise.all([
      refreshChatHistory(sessionId),
      executeDataOperation(api.messages.get, { id: chatId, sessionId }),
    ]);
    if (chat?.description) {
      descriptionStore.set(chat.description);
    } else if (attempt < 2) {
      window.setTimeout(() => void refreshProjectMetadata(attempt + 1), (attempt + 1) * 1_000);
    }
  } catch (error) {
    logger.debug('Unable to refresh generated project title', error);
  }
}
