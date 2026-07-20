import type { UIMessage } from "ai";

export const MAX_PERSISTED_CHAT_MESSAGES = 100;
export const MAX_MODEL_CHAT_MESSAGES = 24;
export const MAX_USER_MESSAGE_TEXT_CHARS = 8_000;
export const MAX_AGENT_OUTPUT_TOKENS = 2_048;

const MAX_MESSAGE_ID_CHARS = 128;
const MAX_ASSISTANT_MESSAGE_TEXT_CHARS = 32_000;

/**
 * Keep the generated chat text-only and bounded even when a client bypasses
 * the starter UI and sends protocol frames directly.
 */
export function sanitizePersistedChatMessage(message: UIMessage): UIMessage {
  const role = message.role === "assistant" ? "assistant" : "user";
  let remaining =
    role === "assistant"
      ? MAX_ASSISTANT_MESSAGE_TEXT_CHARS
      : MAX_USER_MESSAGE_TEXT_CHARS;
  let text = "";
  const parts = Array.isArray(message.parts) ? message.parts : [];
  for (const part of parts) {
    if (
      !part ||
      part.type !== "text" ||
      typeof part.text !== "string" ||
      remaining === 0
    ) {
      continue;
    }
    const chunk = part.text.slice(0, remaining);
    text += chunk;
    remaining -= chunk.length;
  }

  return {
    id: boundedMessageId(message.id),
    role,
    parts: [{ type: "text", text }],
  };
}

function boundedMessageId(id: unknown): string {
  const value = typeof id === "string" ? id : "invalid-message";
  if (value.length <= MAX_MESSAGE_ID_CHARS) {
    return value;
  }
  const half = MAX_MESSAGE_ID_CHARS / 2;
  return `${value.slice(0, half)}${value.slice(-half)}`;
}
