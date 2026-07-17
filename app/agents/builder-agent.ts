import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
  type ChatResponseResult,
} from '@cloudflare/ai-chat';
import { callable } from 'agents';
import { createChatResponseFromBody, type ChatRequestBody } from '~/lib/.server/chat';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import {
  BuilderTurnStore,
  completeBuilderTurn,
  createBuilderTurn,
  createRecoveryTurn,
  type BuilderTurnState,
  type BuilderTurnStatus,
} from './builder-turn-store';
import { DurableObjectContextCompactionRepository } from '~/lib/.server/llm/context-compaction-store';
import { summarizeBuilderContext } from '~/lib/.server/llm/workers-ai-text';
import { chatTurnContextSchema, type ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { getUserWorkersAiCredentials } from '~/lib/.server/cloudflare/workers-ai-billing-context';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { latestPendingDeploymentPlanMarker } from './deployment-continuation';
import { generateProjectTitle } from '~/lib/.server/llm/project-title';
import { setGeneratedDescriptionIfMissing } from '~/lib/cloudflare/data/chat-service.server';
import { messageText } from 'ghostbuild-agent/ai-compat';
import {
  transcriptIdentitySchema,
  transcriptCheckpointSchema,
  transcriptCheckpointsEqual,
  transcriptMessagesEqual,
  stripTranscriptBaseMetadata,
  advanceTranscriptCheckpoint,
  TRANSCRIPT_BASE_METADATA_KEY,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
} from 'ghostbuild-agent/transcript';
import { createWorkersAiSessionAffinity } from '~/lib/.server/llm/workers-ai-prompt-cache';

const logger = createScopedLogger('BuilderAgent');
const STALE_CHAT_RECOVERY_MS = 15 * 60 * 1000;
const MAX_CHAT_RECOVERY_ATTEMPTS = 2;
const CHAT_NO_PROGRESS_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_SUBCHAT_INDEX = 10_000;

export type BuilderAgentState = {
  activeTurn?: BuilderTurnState | null;
  lastCompletedTurn?: BuilderTurnState | null;
  updatedAt?: string;
  transcript?: TranscriptCheckpoint | null;
};

type ChatBody = Partial<ChatRequestBody> & { transcript?: unknown };

type BuilderAgentProps = {
  billingSubjectKey: string;
  ownerId: string;
  userId?: string;
};

export class BuilderAgent extends AIChatAgent<Env, BuilderAgentState, BuilderAgentProps> {
  static override options = {
    sendIdentityOnConnect: false,
  };

  initialState: BuilderAgentState = {
    activeTurn: null,
    lastCompletedTurn: null,
    transcript: null,
  };

  override messageConcurrency = 'queue' as const;

  override waitForMcpConnections = { timeout: 10_000 };

  override chatRecovery = {
    maxAttempts: MAX_CHAT_RECOVERY_ATTEMPTS,
    noProgressTimeoutMs: CHAT_NO_PROGRESS_TIMEOUT_MS,
    terminalMessage: 'The builder was interrupted. Please send your message again.',
  };

  override chatStreamStallTimeoutMs = CHAT_NO_PROGRESS_TIMEOUT_MS;

  private readonly turnStore = new BuilderTurnStore(this);
  private readonly contextCompaction = new DurableObjectContextCompactionRepository(this);
  private billingSubjectKey: string | null = null;
  private ownerId: string | null = null;
  private userId: string | undefined;
  async onStart(props?: BuilderAgentProps) {
    this.billingSubjectKey = props?.billingSubjectKey ?? null;
    this.ownerId = props?.ownerId ?? null;
    this.userId = props?.userId;
    this.turnStore.initialize();
    this.contextCompaction.initialize();
  }

  override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    if (this.state.transcript) {
      await this.advanceTranscriptCheckpoint(this.state.transcript);
    }
    const ageMs = Date.now() - ctx.createdAt;
    const nextTurn = createRecoveryTurn(ctx, this.state.activeTurn);
    this.setState({
      ...this.state,
      activeTurn: nextTurn,
      updatedAt: nextTurn.updatedAt,
    });
    this.turnStore.record(nextTurn);

    logger.warn('Recovering interrupted Ghostbuild chat turn', {
      incidentId: ctx.incidentId,
      recoveryKind: ctx.recoveryKind,
      requestId: ctx.requestId,
      attempt: ctx.attempt,
      ageMs,
      partialTextLength: ctx.partialText.length,
      recoveryData: ctx.recoveryData,
    });

    if (ageMs > STALE_CHAT_RECOVERY_MS) {
      logger.warn('Skipping automatic continuation for stale Ghostbuild chat turn', {
        incidentId: ctx.incidentId,
        ageMs,
      });
      return { persist: true, continue: false };
    }

    return {};
  }

  override async onChatMessage(
    _onFinish?: unknown,
    options?: { requestId?: string; body?: Record<string, unknown>; continuation?: boolean; abortSignal?: AbortSignal },
  ) {
    if (!this.billingSubjectKey) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const body = (options?.body ?? {}) as ChatBody;
    const messages = this.messages as NonNullable<ChatRequestBody['messages']>;
    const pendingDeploymentPlanMarker = options?.continuation ? latestPendingDeploymentPlanMarker(messages) : null;
    if (pendingDeploymentPlanMarker) {
      console.info({
        event: 'builder_deployment_plan_continuation_stopped',
        requestId: options?.requestId,
      });
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => {
            const id = 'deployment-approval-ready';
            writer.write({ type: 'text-start', id });
            writer.write({
              type: 'text-delta',
              id,
              delta: `The production plan is ready. Review the Cloudflare resources and approve billing below.\n\n${pendingDeploymentPlanMarker}`,
            });
            writer.write({ type: 'text-end', id });
          },
        }),
      });
    }
    const chatInitialId = typeof body.chatInitialId === 'string' ? body.chatInitialId : 'agent-chat';
    const subchatIndex = parseSubchatIndex(body.subchatIndex);
    const transcript = this.requireTranscriptIdentity(body.transcript, subchatIndex);
    await this.advanceTranscriptCheckpoint(transcript);
    this.contextCompaction.migrateLegacySubchat(subchatIndex);
    const turnContext = parseTurnContext(body.turnContext);
    const firstUserMessage =
      !options?.continuation && messages.filter((message: { role?: string }) => message.role === 'user').length === 1;
    const firstPrompt = firstUserMessage ? messages.find((message) => message.role === 'user') : undefined;
    const turn = createBuilderTurn({
      requestId: options?.requestId,
      chatInitialId,
      continuation: options?.continuation === true,
      firstUserMessage,
      messages,
    });
    console.info({
      event: 'builder_chat_turn_started',
      requestId: options?.requestId,
      chatInitialId,
      continuation: options?.continuation === true,
      firstUserMessage,
      messageCount: messages.length,
    });
    this.setState({
      ...this.state,
      activeTurn: turn,
      updatedAt: turn.updatedAt,
    });
    this.turnStore.record(turn);

    try {
      const accountCredentials = await getUserWorkersAiCredentials(this.env, this.userId);
      if (firstPrompt) {
        this.ctx.waitUntil(
          this.generateInitialProjectTitle(
            chatInitialId,
            messageText(firstPrompt),
            accountCredentials,
            this.billingSubjectKey,
          ),
        );
      }
      this.stashTurn(turn);
      return await createChatResponseFromBody({
        env: this.env,
        abortSignal: options?.abortSignal,
        firstUserMessage,
        turnContext,
        billingSubjectKey: this.billingSubjectKey,
        accountCredentials,
        sessionAffinity: await createWorkersAiSessionAffinity(transcript),
        compaction: {
          current: this.contextCompaction.getCompaction(),
          summarize: (prompt) =>
            summarizeBuilderContext(this.env, prompt, accountCredentials, this.billingSubjectKey ?? undefined),
          save: (compaction) => this.contextCompaction.saveCompaction(compaction),
        },
        body: {
          messages,
          chatInitialId,
          shouldDisableTools: body.shouldDisableTools === true,
        },
      });
    } catch (error) {
      this.finishTurn(turn, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  protected override async onChatResponse(result: ChatResponseResult) {
    if (this.state.transcript) {
      await this.advanceTranscriptCheckpoint(this.state.transcript);
    }
    const currentTurn = this.state.activeTurn;
    if (!currentTurn) {
      return;
    }

    const status: BuilderTurnStatus =
      result.status === 'completed' ? 'completed' : result.status === 'aborted' ? 'aborted' : 'error';
    this.finishTurn(currentTurn, {
      requestId: result.requestId,
      status,
      error: result.error,
    });
  }

  @callable()
  getTurnHistory(limit = 20) {
    return this.turnStore.getHistory(limit);
  }

  @callable()
  async getTranscriptSnapshot(identityValue?: unknown): Promise<{
    checkpoint: TranscriptCheckpoint | null;
    messages: NonNullable<ChatRequestBody['messages']>;
  }> {
    const checkpoint =
      identityValue === undefined ? (this.state.transcript ?? null) : await this.getTranscriptCheckpoint(identityValue);
    return {
      checkpoint,
      messages: this.messages as NonNullable<ChatRequestBody['messages']>,
    };
  }

  @callable()
  async getTranscriptCheckpoint(identityValue: unknown): Promise<TranscriptCheckpoint | null> {
    const identity = this.requireTranscriptIdentity(identityValue);
    if (!this.state.transcript && this.messages.length > 0) {
      return this.advanceTranscriptCheckpoint(identity);
    }
    return this.state.transcript ?? null;
  }

  @callable()
  async seedTranscript(identityValue: unknown, messagesValue: unknown): Promise<TranscriptCheckpoint> {
    const identity = this.requireTranscriptIdentity(identityValue);
    if (!Array.isArray(messagesValue)) {
      throw new Response('Invalid transcript messages', { status: 400 });
    }
    const messages = messagesValue as NonNullable<ChatRequestBody['messages']>;
    if (this.state.transcript || this.messages.length > 0) {
      return this.advanceTranscriptCheckpoint(identity);
    }
    await this.persistMessages(messages as unknown as UIMessage[]);
    return this.advanceTranscriptCheckpoint(identity);
  }

  protected override sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    const metadata = isRecord(message.metadata) ? message.metadata : null;
    if (!metadata || !Object.hasOwn(metadata, TRANSCRIPT_BASE_METADATA_KEY)) {
      return message;
    }
    const sanitized = stripTranscriptBaseMetadata(message);
    const existing = this.messages.find((candidate) => candidate.id === message.id);
    if (existing && transcriptMessagesEqual(existing, message)) {
      return sanitized;
    }
    const parsed = transcriptCheckpointSchema.nullable().safeParse(metadata[TRANSCRIPT_BASE_METADATA_KEY]);
    if (!parsed.success || !transcriptCheckpointsEqual(this.state.transcript ?? null, parsed.data)) {
      throw new Error('This transcript changed in another session. Reload the latest messages before sending.');
    }
    return sanitized;
  }

  private requireTranscriptIdentity(value: unknown, subchatIndex?: number): TranscriptIdentity {
    const result = transcriptIdentitySchema.safeParse(value);
    if (!result.success) {
      throw new Response('Invalid transcript identity', { status: 400 });
    }
    if (result.data.agentName !== this.name) {
      throw new Response('Transcript identity does not match this agent', { status: 409 });
    }
    if (subchatIndex !== undefined && result.data.subchatIndex !== subchatIndex) {
      throw new Response('Transcript identity does not match the selected subchat', { status: 409 });
    }
    return result.data;
  }

  private async advanceTranscriptCheckpoint(identity: TranscriptIdentity): Promise<TranscriptCheckpoint> {
    const previous = this.state.transcript;
    const checkpoint = await advanceTranscriptCheckpoint(previous ?? null, identity, this.messages);
    if (checkpoint === previous) {
      return previous;
    }
    this.setState({ ...this.state, transcript: checkpoint, updatedAt: new Date().toISOString() });
    return checkpoint;
  }

  private stashTurn(turn: BuilderTurnState) {
    try {
      this.stash({
        kind: 'ghostbuild-chat-turn',
        turn,
        recoveryPlan: {
          onRecovery: 'Persist partial output and continue only when the turn is recent.',
          staleRecoveryMs: STALE_CHAT_RECOVERY_MS,
          contextSource: 'durable AIChatAgent transcript plus this turn checkpoint',
        },
      });
    } catch (error) {
      logger.warn('Unable to stash Ghostbuild chat turn recovery context', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async generateInitialProjectTitle(
    chatInitialId: string,
    firstPrompt: string,
    accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>,
    billingSubjectKey: string,
  ): Promise<void> {
    if (!this.ownerId) {
      return;
    }
    try {
      const title = await generateProjectTitle(this.env, firstPrompt, accountCredentials, billingSubjectKey);
      if (!title) {
        return;
      }
      const saved = await setGeneratedDescriptionIfMissing(this.env.DB, {
        sessionId: this.ownerId,
        id: chatInitialId,
        description: title,
      });
      logger.info(saved ? 'Generated initial project title' : 'Kept existing project title', { chatInitialId });
    } catch (error) {
      logger.warn('Project title generation failed; keeping first-prompt fallback', {
        chatInitialId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private finishTurn(
    turn: BuilderTurnState,
    result: { status: BuilderTurnStatus; requestId?: string; error?: string },
  ) {
    const finishedTurn = completeBuilderTurn(turn, result);
    this.setState({
      ...this.state,
      activeTurn: null,
      lastCompletedTurn: finishedTurn,
      updatedAt: finishedTurn.updatedAt,
    });
    this.turnStore.record(finishedTurn);
  }
}

function parseSubchatIndex(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SUBCHAT_INDEX) {
    throw new Response('Invalid subchat index', { status: 400 });
  }
  return value as number;
}

function parseTurnContext(value: unknown): ChatTurnContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = chatTurnContextSchema.safeParse(value);
  if (!result.success) {
    throw new Response('Invalid turn context', { status: 400 });
  }
  return result.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
