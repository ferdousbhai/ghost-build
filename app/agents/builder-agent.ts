import { AIChatAgent, type ChatRecoveryContext, type ChatRecoveryOptions } from '@cloudflare/ai-chat';
import { callable, type Connection } from 'agents';
import { createChatResponseFromBody, type ChatRequestBody } from '~/lib/.server/chat';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const logger = createScopedLogger('BuilderAgent');

export type BuilderAgentState = {
  lastPrompt?: string;
  lastSummary?: string;
  promptCount: number;
  updatedAt?: string;
};

type ChatBody = Partial<ChatRequestBody>;

type PromptHistoryRow = {
  id: string;
  prompt: string;
  created_at: string;
};

type UnknownRecord = Record<string, unknown>;

export class BuilderAgent extends AIChatAgent<Env, BuilderAgentState> {
  static override options = {
    sendIdentityOnConnect: false,
  };

  initialState: BuilderAgentState = {
    promptCount: 0,
  };

  override maxPersistedMessages = 200;

  override messageConcurrency = 'queue' as const;

  override waitForMcpConnections = { timeout: 10_000 };

  override chatRecovery = {
    maxAttempts: 6,
    terminalMessage: 'The builder was interrupted. Please send your message again.',
  };

  override chatStreamStallTimeoutMs = 60_000;

  async onStart() {
    const _promptHistoryTable = this.sql`
      CREATE TABLE IF NOT EXISTS prompt_history (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;

    const _stateUpdatesTable = this.sql`
      CREATE TABLE IF NOT EXISTS agent_state_updates (
        id TEXT PRIMARY KEY,
        prompt_count INTEGER NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
  }

  override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    logger.warn('Recovering interrupted Ghostbuild chat turn', {
      requestId: ctx.requestId,
      attempt: ctx.attempt,
    });
    return {};
  }

  override async onChatMessage(
    _onFinish?: unknown,
    options?: { body?: Record<string, unknown>; continuation?: boolean; abortSignal?: AbortSignal },
  ) {
    const body = (options?.body ?? {}) as ChatBody;
    const messages = this.messages as NonNullable<ChatRequestBody['messages']>;
    const preparedMessages =
      !options?.continuation && Array.isArray(body.preparedMessages) ? body.preparedMessages : undefined;
    const chatInitialId = typeof body.chatInitialId === 'string' ? body.chatInitialId : 'agent-chat';

    return createChatResponseFromBody({
      env: this.env,
      abortSignal: options?.abortSignal,
      body: {
        messages,
        preparedMessages,
        firstUserMessage: options?.continuation
          ? false
          : typeof body.firstUserMessage === 'boolean'
            ? body.firstUserMessage
            : messages.filter((message: { role?: string }) => message.role === 'user').length === 1,
        chatInitialId,
        shouldDisableTools: body.shouldDisableTools === true,
        collapsedMessages: body.collapsedMessages === true,
        promptCharacterCounts: body.promptCharacterCounts,
      },
    });
  }

  onStateChanged(state: BuilderAgentState | undefined, source: Connection | 'server') {
    if (!state?.updatedAt) {
      return;
    }

    const _stateUpdateRows = this.sql`
      INSERT OR REPLACE INTO agent_state_updates (id, prompt_count, source, updated_at)
      VALUES ('latest', ${state.promptCount}, ${source === 'server' ? 'server' : 'client'}, ${state.updatedAt})
    `;
  }

  @callable()
  async rememberPrompt(prompt: string) {
    if (typeof prompt !== 'string') {
      return { ok: false, updatedAt: this.state.updatedAt };
    }

    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      return { ok: false, updatedAt: this.state.updatedAt };
    }

    const updatedAt = new Date().toISOString();
    const promptCount = this.state.promptCount + 1;

    const _promptHistoryRows = this.sql`
      INSERT INTO prompt_history (id, prompt, created_at)
      VALUES (${crypto.randomUUID()}, ${cleanPrompt}, ${updatedAt})
    `;

    this.setState({ ...this.state, lastPrompt: cleanPrompt, promptCount, updatedAt });
    return { ok: true, promptCount, updatedAt };
  }

  @callable()
  async summarizeLastPrompt() {
    if (!this.state.lastPrompt) {
      return { summary: '' };
    }

    const result = await this.env.AI.run(CLOUDFLARE_WORKERS_AI_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'Summarize this app-builder prompt in one concise sentence.',
        },
        {
          role: 'user',
          content: this.state.lastPrompt,
        },
      ],
    });
    const summary = extractAiText(result);
    const updatedAt = new Date().toISOString();
    this.setState({ ...this.state, lastSummary: summary, updatedAt });

    return { summary };
  }

  @callable()
  getPromptHistory(limit = 20) {
    const numericLimit = Number.isFinite(limit) ? limit : 20;
    const boundedLimit = Math.min(Math.max(Math.trunc(numericLimit), 1), 50);
    return this.sql<PromptHistoryRow>`
      SELECT id, prompt, created_at
      FROM prompt_history
      ORDER BY created_at DESC
      LIMIT ${boundedLimit}
    `;
  }
}

function extractAiText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!isRecord(value)) {
    return '';
  }

  const directText = getStringProperty(value, 'response') ?? getStringProperty(value, 'output_text');
  if (directText !== undefined) {
    return directText;
  }

  const firstChoice = Array.isArray(value.choices) ? value.choices[0] : undefined;
  if (isRecord(firstChoice)) {
    const messageText = isRecord(firstChoice.message) ? getStringProperty(firstChoice.message, 'content') : undefined;
    const choiceText = messageText ?? getStringProperty(firstChoice, 'text');
    if (choiceText !== undefined) {
      return choiceText;
    }
  }

  return JSON.stringify(value);
}

function getStringProperty(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}
