import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAgent } from 'agents/react';
import type { UIMessage } from 'ai';
import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useRef } from 'react';
import type { BuilderAgent, BuilderAgentState } from '~/agents/builder-agent';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { ToolCallAbortedError } from '~/lib/stores/workbench-artifacts';
import { getAuthToken, sessionIdStore } from '~/lib/stores/sessionId';
import { captureMessage } from '~/lib/telemetry.client';
import { ChatContextManager } from 'ghostbuild-agent/ChatContextManager';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { GhostbuildMessage, GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { STATUS_MESSAGES } from './StreamingIndicator';
import { recordChatFailure, resetChatRetryState } from './chat-retry';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { buildBuilderAgentRequest } from './builder-agent-request';
import { waitForAgentSocketOpen } from './agent-connection';
import { deliverToolOutput } from './tool-output-delivery';
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

const logger = createScopedLogger('BuilderAgentChat');
const AGENT_SEND_READY_TIMEOUT_MS = 10_000;

export function useBuilderAgentChat(args: {
  chatInitialId: string;
  initialMessages: GhostbuildMessage[];
  transcript: TranscriptIdentity;
  seedTranscript: boolean;
}) {
  const currentSubchatIndex = useStore(subchatIndexStore);
  const stopRef = useRef<() => void>(() => undefined);
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
  });
  const chat = useAgentChat<BuilderAgentState, UIMessage>({
    agent: builderAgent,
    getInitialMessages: null,
    messages: args.initialMessages as UIMessage[],
    syncMessagesToServer: false,
    experimental_throttle: 100,
    prepareSendMessagesRequest: ({ messages, body }) => {
      const ghostMessages = messages as GhostbuildMessage[];
      if (!getAuthToken()) {
        throw new Error('No token');
      }
      const requestBody = buildBuilderAgentRequest({
        messages: ghostMessages,
        body,
        chatInitialId: args.chatInitialId,
        subchatIndex: subchatIndexStore.get() ?? 0,
        transcript: args.transcript,
      });
      return { body: requestBody };
    },
    onToolCall({ toolCall, addToolOutput }) {
      logger.debug('Starting tool call', toolCall);
      void (async () => {
        const invocation: GhostbuildToolInvocation = {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.input,
          state: 'call',
        };
        try {
          const { result } = await workbenchStore.runToolInvocation(invocation);
          deliverToolOutput({
            deliver: addToolOutput,
            output: { toolCallId: toolCall.toolCallId, output: result },
            onFailure: (deliveryError) =>
              handleToolOutputDeliveryFailure(deliveryError, toolCall.toolName, stopRef.current),
          });
        } catch (error) {
          if (error instanceof ToolCallAbortedError) {
            logger.debug('Tool call waiter aborted', toolCall.toolCallId);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          deliverToolOutput({
            deliver: addToolOutput,
            output: { toolCallId: toolCall.toolCallId, state: 'output-error', errorText: message },
            onFailure: (deliveryError) =>
              handleToolOutputDeliveryFailure(deliveryError, toolCall.toolName, stopRef.current),
          });
          captureMessage('Builder client tool call failed', {
            level: 'error',
            extra: { error, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName },
          });
        }
      })();
    },
    autoContinueAfterToolResult: true,
    onError: (error: Error) => {
      captureMessage(`Failed to process chat request: ${error.message}`, {
        level: 'error',
        extra: { error },
      });
      logger.error('Chat request failed', error);
      recordChatFailure(error.message.includes(STATUS_MESSAGES.error));
      workbenchStore.abortAllActions();
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
      void refreshProjectMetadata();
    },
  });
  stopRef.current = chat.stop;
  const setMessagesRef = useRef(chat.setMessages);
  const initialMessagesRef = useRef(args.initialMessages);
  setMessagesRef.current = chat.setMessages;
  initialMessagesRef.current = args.initialMessages;
  const seedKey = args.seedTranscript
    ? `${args.transcript.agentName}:${args.transcript.generation}:${args.transcript.subchatIndex}`
    : null;
  const seedGateRef = useRef<{
    key: string | null;
    promise: Promise<void>;
    resolve: () => void;
    error: unknown;
    started: boolean;
  }>({ key: null, promise: Promise.resolve(), resolve: () => undefined, error: null, started: false });
  if (seedGateRef.current.key !== seedKey) {
    let resolve: () => void = () => undefined;
    const promise = seedKey
      ? new Promise<void>((complete) => {
          resolve = complete;
        })
      : Promise.resolve();
    seedGateRef.current = { key: seedKey, promise, resolve, error: null, started: false };
  }

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
  }, [args.initialMessages, args.transcript, builderAgent, seedKey]);

  const sendMessage = useCallback(
    async (
      message: Parameters<typeof chat.sendMessage>[0],
      options?: Parameters<typeof chat.sendMessage>[1],
      onRequestStart?: () => void,
    ) => {
      const gate = seedGateRef.current;
      await gate.promise;
      if (gate.error) {
        throw gate.error;
      }
      try {
        await waitForAgentSocketOpen(builderAgent, AGENT_SEND_READY_TIMEOUT_MS, { requireIdentity: false });
      } catch (error) {
        logger.warn('Builder connection was not ready before send', error);
        captureMessage('Builder connection was not ready before send', {
          level: 'error',
          extra: { error },
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
    [args.transcript, builderAgent, chat],
  );

  useEffect(() => {
    setMessagesRef.current(initialMessagesRef.current as UIMessage[]);
    contextManager.current.reset();
  }, [currentSubchatIndex]);

  return {
    ...chat,
    sendMessage,
    messages: chat.messages as GhostbuildMessage[],
    contextManager: contextManager.current,
    streamStatus: chat.isRecovering ? ('submitted' as const) : chat.isStreaming ? ('streaming' as const) : chat.status,
    transcriptCheckpoint:
      builderAgent.state?.transcript && transcriptIdentitiesEqual(builderAgent.state.transcript, args.transcript)
        ? builderAgent.state.transcript
        : null,
  };
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

function handleToolOutputDeliveryFailure(error: unknown, toolName: string, stop: () => void): void {
  logger.error('Failed to deliver tool output for continuation', error);
  captureMessage('Failed to deliver Builder tool output for continuation', {
    level: 'error',
    extra: { error, toolName },
  });
  workbenchStore.abortAllActions();
  stop();
}
