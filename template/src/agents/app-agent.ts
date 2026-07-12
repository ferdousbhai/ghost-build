import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
} from "@cloudflare/ai-chat";
import { convertToModelMessages, pruneMessages, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { WORKERS_AI_CODING_MODEL } from "../workers-ai.shared";

export class AppAgent extends AIChatAgent<Env> {
  override messageConcurrency = "queue" as const;
  override chatRecovery = {
    maxAttempts: 6,
    noProgressTimeoutMs: 5 * 60 * 1000,
    terminalMessage:
      "The assistant was interrupted. Please send your message again.",
  };
  override chatStreamStallTimeoutMs = 5 * 60 * 1000;

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
}
