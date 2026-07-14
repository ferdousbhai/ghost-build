import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
  type ChatResponseResult,
} from '@cloudflare/ai-chat';
import { callable } from 'agents';
import { createChatResponseFromBody, type ChatRequestBody } from '~/lib/.server/chat';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { ROLE_SYSTEM_PROMPT, generalSystemPrompt } from 'ghostbuild-agent/prompts/system';
import {
  BuilderTurnStore,
  completeBuilderTurn,
  createBuilderTurn,
  createRecoveryTurn,
  type BuilderTurnState,
  type BuilderTurnStatus,
} from './builder-turn-store';
import {
  contextScopeForSubchat,
  DurableObjectContextCompactionRepository,
} from '~/lib/.server/llm/context-compaction-store';
import { ContextWindowManager } from '~/lib/.server/llm/context-window-manager';
import { summarizeBuilderContext } from '~/lib/.server/llm/workers-ai-text';
import { chatTurnContextSchema, type ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { getWorkersAiToolContext } from '~/lib/.server/llm/workers-ai-tools';
import { getUserWorkersAiCredentials } from '~/lib/.server/cloudflare/workers-ai-billing-context';

const logger = createScopedLogger('BuilderAgent');
const STALE_CHAT_RECOVERY_MS = 15 * 60 * 1000;
const MAX_CHAT_RECOVERY_ATTEMPTS = 2;
const CHAT_NO_PROGRESS_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_SUBCHAT_INDEX = 10_000;

export type BuilderAgentState = {
  activeTurn?: BuilderTurnState | null;
  lastCompletedTurn?: BuilderTurnState | null;
  updatedAt?: string;
};

type ChatBody = Partial<ChatRequestBody>;

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
  private billingSubjectKey: string | null = null;
  private userId: string | undefined;
  private readonly contextWindow = new ContextWindowManager({
    repository: new DurableObjectContextCompactionRepository(this),
    summarize: async (prompt) =>
      summarizeBuilderContext(
        this.env,
        prompt,
        await getUserWorkersAiCredentials(this.env, this.userId),
        this.billingSubjectKey ?? undefined,
      ),
    systemPrompts: () => [ROLE_SYSTEM_PROMPT, generalSystemPrompt(), getWorkersAiToolContext()],
    logger,
  });

  async onStart(props?: BuilderAgentProps) {
    this.billingSubjectKey = props?.billingSubjectKey ?? null;
    this.userId = props?.userId;
    this.turnStore.initialize();
    this.contextWindow.initialize();
  }

  override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
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
    const chatInitialId = typeof body.chatInitialId === 'string' ? body.chatInitialId : 'agent-chat';
    const subchatIndex = parseSubchatIndex(body.subchatIndex);
    const contextScope = contextScopeForSubchat(subchatIndex);
    const turnContext = parseTurnContext(body.turnContext);
    const firstUserMessage =
      !options?.continuation && messages.filter((message: { role?: string }) => message.role === 'user').length === 1;
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
      const preparedContext = await this.contextWindow.prepare(messages, contextScope, turnContext);
      const accountCredentials = await getUserWorkersAiCredentials(this.env, this.userId);
      console.info({
        event: 'builder_context_prepared',
        requestId: options?.requestId,
        chatInitialId,
        contextReduced: preparedContext.contextReduced,
        messageCount: preparedContext.messages.length,
      });
      this.stashTurn(turn, preparedContext.contextReduced);
      return await createChatResponseFromBody({
        env: this.env,
        abortSignal: options?.abortSignal,
        firstUserMessage,
        preparedMessages: preparedContext.messages,
        billingSubjectKey: this.billingSubjectKey,
        accountCredentials,
        contextReduced: preparedContext.contextReduced,
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

  protected override onChatResponse(result: ChatResponseResult) {
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
  getContextStatus(subchatIndex = 0) {
    return this.contextWindow.getStatus(contextScopeForSubchat(parseSubchatIndex(subchatIndex)));
  }

  private stashTurn(turn: BuilderTurnState, contextReduced: boolean) {
    try {
      this.stash({
        kind: 'ghostbuild-chat-turn',
        turn,
        recoveryPlan: {
          onRecovery: 'Persist partial output and continue only when the turn is recent.',
          staleRecoveryMs: STALE_CHAT_RECOVERY_MS,
          contextSource: 'durable AIChatAgent transcript plus this turn checkpoint',
        },
        contextReduced,
      });
    } catch (error) {
      logger.warn('Unable to stash Ghostbuild chat turn recovery context', {
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
