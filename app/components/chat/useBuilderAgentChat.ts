import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAgent } from 'agents/react';
import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BuilderAgent, BuilderAgentState } from '~/agents/builder-agent';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { isAuthenticated } from '~/lib/stores/userId';
import { captureMessage } from '~/lib/telemetry.client';
import { ChatContextManager } from 'ghostbuild-agent/ChatContextManager';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { UIMessage } from 'ai';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { STATUS_MESSAGES } from './StreamingIndicator';
import { recordChatFailure, resetChatRetryState } from './chat-retry';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { waitForAgentSocketOpen } from './agent-connection';
import { CLOUDFLARE_AI_FUNDING_REQUIRED_MARKER, WORKERS_PAID_REQUIRED_MARKER } from '~/lib/workers-paid';
import { showCloudflareAiFundingRequiredToast, showWorkersPaidRequiredToast } from '~/lib/workers-paid.client';
import { refreshChatHistory } from '~/lib/cloudflare/chat-history-db';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { description as descriptionStore } from '~/lib/stores/description';
import {
  transcriptCheckpointsEqual,
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
import { requireUserRuntimeEndpoint } from '~/lib/cloudflare/runtime-session';
import { builderModelStore } from '~/lib/stores/builder-model.client';
import { isWorkersAiModelId } from '~/lib/workers-ai-model';
import { loadAuthoritativeTranscriptSnapshot, reconcileMessagesForSend } from './chat-send-reconciliation';
import { BUILDER_AGENT_QUERY_CACHE_TTL_MS, loadBuilderAgentCapability } from './builder-agent-auth';

const logger = createScopedLogger('BuilderAgentChat');
const AGENT_SEND_READY_TIMEOUT_MS = 10_000;
const AGENT_CANCEL_SETTLE_TIMEOUT_MS = 5 * 60 * 1000;

export function workspacePresentationId(accountId: string, agentName: string): string {
  return `${accountId}:${agentName}`;
}

export function useBuilderAgentChat(args: {
  accountId: string;
  chatInitialId: string;
  initialMessages: GhostbuildMessage[];
  onSubchatTitle: (subchatIndex: number, title: string) => void;
  presentationId: string;
  transcript: TranscriptIdentity;
}) {
  const activePresentationRef = useRef<string | null>(args.presentationId);
  activePresentationRef.current = args.presentationId;
  useEffect(
    () => () => {
      if (activePresentationRef.current === args.presentationId) {
        activePresentationRef.current = null;
      }
    },
    [args.presentationId],
  );
  const transcript = useMemo<TranscriptIdentity>(
    () => ({
      agentName: args.transcript.agentName,
      generation: args.transcript.generation,
      subchatIndex: args.transcript.subchatIndex,
    }),
    [args.transcript.agentName, args.transcript.generation, args.transcript.subchatIndex],
  );
  const currentSubchatIndex = useStore(subchatIndexStore);
  const workspaceReplica = useAccountLocalReplica(args.accountId);
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
  const runtimeEndpoint = new URL(requireUserRuntimeEndpoint());
  const runtimeOrigin = runtimeEndpoint.origin;
  const builderAgent = useAgent<BuilderAgent, BuilderAgentState>({
    agent: 'BuilderAgent',
    name: transcript.agentName,
    host: runtimeEndpoint.host,
    protocol: runtimeEndpoint.protocol === 'https:' ? 'wss' : 'ws',
    query: loadBuilderAgentCapability,
    queryDeps: [args.accountId, runtimeOrigin],
    // A finite query TTL replaces the live socket when it expires. Refresh the
    // short-lived capability only when the SDK reconnects or this identity changes.
    cacheTtl: BUILDER_AGENT_QUERY_CACHE_TTL_MS,
    onStateUpdate: (state) => {
      if (activePresentationRef.current !== args.presentationId) {
        return;
      }
      if (state.preview) {
        workbenchStore.updatePreview(state.preview);
      }
      const generatedTitle = state.generatedSubchatTitle;
      if (!generatedTitle || generatedSubchatTitleUpdatedAtRef.current === generatedTitle.updatedAt) {
        return;
      }
      generatedSubchatTitleUpdatedAtRef.current = generatedTitle.updatedAt;
      args.onSubchatTitle(generatedTitle.subchatIndex, generatedTitle.title);
      const chatId = args.chatInitialId;
      if (chatId) {
        void queryClient.invalidateQueries({
          queryKey: subchatQueryKey({ chatId, sessionId: args.accountId }),
        });
      }
    },
  });
  const workspaceControllerRef = useRef<BuilderWorkspaceSyncController | null>(null);
  const workspaceGateRef = useAsyncGate(args.presentationId);
  const chat = useAgentChat<BuilderAgentState, UIMessage>({
    agent: builderAgent,
    getInitialMessages: null,
    messages: args.initialMessages as UIMessage[],
    syncMessagesToServer: false,
    experimental_throttle: 100,
    prepareSendMessagesRequest: ({ body }) => {
      if (!isAuthenticated()) {
        throw new Error('Not authenticated');
      }
      return {
        body: {
          ...body,
          modelId: isWorkersAiModelId(body?.modelId) ? body.modelId : builderModelStore.get(),
          chatInitialId: args.chatInitialId,
          subchatIndex: subchatIndexStore.get() ?? 0,
          transcript,
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
      } else if (error.message.includes(CLOUDFLARE_AI_FUNDING_REQUIRED_MARKER)) {
        showCloudflareAiFundingRequiredToast();
      }
      void refreshProjectMetadata(
        args.chatInitialId,
        args.accountId,
        () => activePresentationRef.current === args.presentationId,
      );
    },
    onFinish: ({ finishReason, message }) => {
      if (activePresentationRef.current === args.presentationId) {
        // Record final tool outputs before stopping any provider-ended incomplete
        // calls; sampled message processing may not have observed the last chunk yet.
        toolActivityStore.finishTurn(message as GhostbuildMessage);
      }
      if (finishReason === 'stop') {
        resetChatRetryState();
      }
      logger.debug('Finished streaming');
      void workspaceControllerRef.current?.pull().catch((workspaceError) => {
        logger.error('Failed to refresh the durable workspace presentation after a builder response', workspaceError);
      });
      void refreshProjectMetadata(
        args.chatInitialId,
        args.accountId,
        () => activePresentationRef.current === args.presentationId,
      );
    },
  });
  const setMessagesRef = useRef(chat.setMessages);
  const messagesRef = useRef(chat.messages as GhostbuildMessage[]);
  const chatTerminalStateRef = useRef({ status: chat.status, isRecovering: chat.isRecovering });
  const builderTranscriptRef = useRef(builderAgent.state?.transcript);
  const stopBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const initialMessagesRef = useRef(args.initialMessages);
  setMessagesRef.current = chat.setMessages;
  messagesRef.current = chat.messages as GhostbuildMessage[];
  chatTerminalStateRef.current = { status: chat.status, isRecovering: chat.isRecovering };
  builderTranscriptRef.current = builderAgent.state?.transcript;
  initialMessagesRef.current = args.initialMessages;

  const readAuthoritativeTranscript = useCallback(
    () =>
      loadAuthoritativeTranscriptSnapshot({
        expectedIdentity: transcript,
        read: () =>
          (
            builderAgent as unknown as {
              call(
                method: 'getTranscriptSnapshot',
                args: [TranscriptIdentity],
                options: { timeout: number },
              ): Promise<unknown>;
            }
          ).call('getTranscriptSnapshot', [transcript], { timeout: AGENT_SEND_READY_TIMEOUT_MS }),
      }),
    [builderAgent, transcript],
  );

  useEffect(() => {
    let disposed = false;
    const callPreview = async (method: 'getPreviewState' | 'requestPreview') => {
      const state = (await builderAgent.call(method, [], {
        timeout: method === 'getPreviewState' ? 10_000 : 30_000,
      })) as NonNullable<BuilderAgentState['preview']>;
      if (!disposed) {
        workbenchStore.updatePreview(state);
      }
      return state;
    };
    const disconnect = workbenchStore.connectPreview({
      request: () => callPreview('requestPreview'),
    });
    void callPreview('getPreviewState').catch((error) => logger.warn('Unable to load remote preview state', error));
    return () => {
      disposed = true;
      disconnect();
    };
  }, [builderAgent]);

  useEffect(() => {
    if (workspaceReplica === undefined) {
      return () => undefined;
    }
    const gate = workspaceGateRef.current;
    if (gate.key !== args.presentationId || gate.started) {
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
          workspaceId: args.presentationId,
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
  }, [args.presentationId, builderAgent, workspaceGateRef, workspaceReplica]);

  const sendMessage = useCallback(
    async (
      message: Parameters<typeof chat.sendMessage>[0],
      options?: Parameters<typeof chat.sendMessage>[1],
      onRequestStart?: () => void,
    ) => {
      const workspaceGate = workspaceGateRef.current;
      await Promise.all([workspaceGate.promise, stopBarrierRef.current]);
      if (workspaceGate.error) {
        throw workspaceGate.error;
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
        const snapshot = await readAuthoritativeTranscript();
        const localMessages = messagesRef.current;
        const reconciledMessages = await reconcileMessagesForSend({
          snapshot,
          localMessages,
        });
        if (reconciledMessages !== localMessages) {
          setMessagesRef.current(reconciledMessages as UIMessage[]);
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
              metadata: { ...metadata, [TRANSCRIPT_BASE_METADATA_KEY]: snapshot.checkpoint },
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
    [builderAgent, chat, readAuthoritativeTranscript, workspaceGateRef],
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
    toolActivityStore.abortActive();
    setMessagesRef.current(initialMessagesRef.current as UIMessage[]);
    contextManager.current.reset();
  }, [currentSubchatIndex]);

  useEffect(() => {
    const durableCheckpoint = builderAgent.state?.transcript;
    if (durableCheckpoint === undefined || (chat.status !== 'ready' && chat.status !== 'error') || chat.isRecovering) {
      return undefined;
    }
    let disposed = false;
    void readAuthoritativeTranscript()
      .then(async (snapshot) => {
        const terminal = chatTerminalStateRef.current;
        if (
          disposed ||
          (terminal.status !== 'ready' && terminal.status !== 'error') ||
          terminal.isRecovering ||
          !transcriptCheckpointsEqual(builderTranscriptRef.current ?? null, snapshot.checkpoint)
        ) {
          return;
        }
        const localMessages = messagesRef.current;
        const reconciledMessages = await reconcileMessagesForSend({ snapshot, localMessages });
        if (!disposed && reconciledMessages !== localMessages) {
          setMessagesRef.current(reconciledMessages as UIMessage[]);
        }
      })
      .catch((error) => logger.warn('Unable to reconcile the durable builder transcript', error));
    return () => {
      disposed = true;
    };
  }, [builderAgent.state?.transcript, chat.isRecovering, chat.status, readAuthoritativeTranscript]);

  return {
    ...chat,
    stop,
    sendMessage,
    messages: chat.messages as GhostbuildMessage[],
    contextManager: contextManager.current,
    streamStatus: chat.isRecovering ? ('submitted' as const) : chat.isStreaming ? ('streaming' as const) : chat.status,
    transcriptCheckpoint:
      builderAgent.state?.transcript && transcriptIdentitiesEqual(builderAgent.state.transcript, transcript)
        ? builderAgent.state.transcript
        : null,
    validationStage: builderAgent.state?.validationProgress?.stage ?? null,
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

async function refreshProjectMetadata(
  chatId: string,
  accountId: string,
  isActive: () => boolean,
  attempt = 0,
): Promise<void> {
  if (!chatId || !isActive()) {
    return;
  }
  try {
    const [, chat] = await Promise.all([
      refreshChatHistory(accountId),
      executeDataOperation(api.messages.get, { id: chatId, sessionId: accountId }),
    ]);
    if (!isActive()) {
      return;
    }
    if (chat?.description) {
      descriptionStore.set(chat.description);
    } else if (attempt < 2) {
      window.setTimeout(
        () => void refreshProjectMetadata(chatId, accountId, isActive, attempt + 1),
        (attempt + 1) * 1_000,
      );
    }
  } catch (error) {
    logger.debug('Unable to refresh generated project title', error);
  }
}
