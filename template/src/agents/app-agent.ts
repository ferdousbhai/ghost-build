import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
} from "@cloudflare/ai-chat";
import { callable, type Connection } from "agents";
import { convertToModelMessages, pruneMessages, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { WORKERS_AI_CODING_MODEL, extractAiText } from "../workers-ai.shared";

export type AppAgentState = {
  notes: string[];
  lastSummary: string | null;
  updatedAt: number | null;
};

export class AppAgent extends AIChatAgent<Env, AppAgentState> {
  static override options = {
    sendIdentityOnConnect: false,
  };

  initialState: AppAgentState = {
    notes: [],
    lastSummary: null,
    updatedAt: null,
  };
  override maxPersistedMessages = 200;
  override messageConcurrency = "queue" as const;
  override waitForMcpConnections = { timeout: 10_000 };
  override chatRecovery = {
    maxAttempts: 6,
    terminalMessage:
      "The assistant was interrupted. Please send your message again.",
  };
  override chatStreamStallTimeoutMs = 60_000;

  override async onChatRecovery(
    ctx: ChatRecoveryContext,
  ): Promise<ChatRecoveryOptions> {
    console.warn("Recovering AppAgent chat turn", {
      incidentId: ctx.incidentId,
      recoveryKind: ctx.recoveryKind,
    });
    return {};
  }

  override async onChatMessage(
    _onFinish?: unknown,
    options?: { abortSignal?: AbortSignal },
  ) {
    const workersAi = createWorkersAI({ binding: this.env.AI });
    const modelMessages = await convertToModelMessages(this.messages);
    const result = streamText({
      model: workersAi(WORKERS_AI_CODING_MODEL),
      abortSignal: options?.abortSignal,
      system:
        "You are a concise coding assistant running on Cloudflare Workers AI. Prefer TanStack Start, Cloudflare Workers, Workers AI, Cloudflare D1, R2, and Cloudflare Agents patterns.",
      messages: pruneMessages({
        messages: modelMessages,
        reasoning: "before-last-message",
        toolCalls: "before-last-message",
      }),
    });

    return result.toUIMessageStreamResponse();
  }

  async onStart() {
    const _noteEventsTable = this.sql`
      CREATE TABLE IF NOT EXISTS note_events (
        id TEXT PRIMARY KEY,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;

    const _stateUpdatesTable = this.sql`
      CREATE TABLE IF NOT EXISTS agent_state_updates (
        id TEXT PRIMARY KEY,
        note_count INTEGER NOT NULL,
        source TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
  }

  onStateChanged(
    state: AppAgentState | undefined,
    source: Connection | "server",
  ) {
    if (!state?.updatedAt) {
      return;
    }

    const _stateUpdateRows = this.sql`
      INSERT OR REPLACE INTO agent_state_updates (id, note_count, source, updated_at)
      VALUES ('latest', ${state.notes.length}, ${source === "server" ? "server" : "client"}, ${state.updatedAt})
    `;
  }

  @callable()
  remember(note: string) {
    if (typeof note !== "string") {
      return this.state;
    }

    const cleanNote = note.trim();
    if (!cleanNote) {
      return this.state;
    }

    const notes = [...this.state.notes, cleanNote].slice(-20);
    const updatedAt = Date.now();
    const _noteEventRows = this.sql`
      INSERT INTO note_events (id, note, created_at)
      VALUES (${crypto.randomUUID()}, ${cleanNote}, ${updatedAt})
    `;
    this.setState({ ...this.state, notes, updatedAt });
    return this.state;
  }

  @callable()
  clear() {
    this.setState({ notes: [], lastSummary: null, updatedAt: Date.now() });
    return this.state;
  }

  @callable()
  async summarize() {
    const result = await this.env.AI.run(WORKERS_AI_CODING_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "Summarize these application notes into concrete next steps.",
        },
        {
          role: "user",
          content: this.state.notes.join("\n"),
        },
      ],
    });
    const lastSummary = extractAiText(result);
    this.setState({ ...this.state, lastSummary, updatedAt: Date.now() });
    return lastSummary;
  }
}
