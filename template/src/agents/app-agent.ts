import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
} from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  streamText,
  type UIMessage,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { WORKERS_AI_CODING_MODEL } from "../workers-ai.shared";
import { consumeAppAgentInferenceBudget } from "../agent-security";
import {
  expireAnonymousAgent,
  refreshAnonymousAgentRetention,
} from "./anonymous-retention";
import {
  MAX_AGENT_OUTPUT_TOKENS,
  MAX_MODEL_CHAT_MESSAGES,
  MAX_PERSISTED_CHAT_MESSAGES,
  sanitizePersistedChatMessage,
} from "./chat-policy";

export class AppAgent extends AIChatAgent<Env> {
  static override options = { sendIdentityOnConnect: false };
  override maxPersistedMessages = MAX_PERSISTED_CHAT_MESSAGES;
  override messageConcurrency = "drop" as const;
  override chatRecovery = {
    maxAttempts: 6,
    noProgressTimeoutMs: 5 * 60 * 1000,
    terminalMessage:
      "The assistant was interrupted. Please send your message again.",
  };
  override chatStreamStallTimeoutMs = 5 * 60 * 1000;

  async refreshAnonymousSessionExpiry(expiresAt: number): Promise<boolean> {
    return refreshAnonymousAgentRetention(this, expiresAt);
  }

  async expireAnonymousSession(payload: { expiresAt: number }): Promise<void> {
    await expireAnonymousAgent(this, payload);
  }

  override async onChatRecovery(
    ctx: ChatRecoveryContext,
  ): Promise<ChatRecoveryOptions> {
    console.warn("Recovering AppAgent chat turn", {
      incidentId: ctx.incidentId,
      recoveryKind: ctx.recoveryKind,
    });
    return {};
  }

  protected override sanitizeMessageForPersistence(
    message: UIMessage,
  ): UIMessage {
    return sanitizePersistedChatMessage(message);
  }

  override async onChatMessage(
    _onFinish?: unknown,
    options?: { abortSignal?: AbortSignal },
  ) {
    const budget = await consumeAppAgentInferenceBudget(this.env.DB, this.name);
    if (!budget.allowed) {
      return Response.json(
        { error: "Agent request limit reached. Try again shortly." },
        {
          status: 429,
          headers: {
            "Retry-After": String(budget.retryAfterSeconds),
            "Cache-Control": "no-store",
          },
        },
      );
    }
    const workersAi = createWorkersAI({ binding: this.env.AI });
    const modelMessages = await convertToModelMessages(
      this.messages.slice(-MAX_MODEL_CHAT_MESSAGES),
    );
    const result = streamText({
      model: workersAi(WORKERS_AI_CODING_MODEL),
      abortSignal: options?.abortSignal,
      maxOutputTokens: MAX_AGENT_OUTPUT_TOKENS,
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
}
