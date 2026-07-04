export const WORKERS_AI_CODING_MODEL = "@cf/zai-org/glm-5.2";

type UnknownRecord = Record<string, unknown>;

export function extractAiText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return "";
  }

  const directText =
    getStringProperty(value, "response") ??
    getStringProperty(value, "output_text");
  if (directText !== undefined) {
    return directText;
  }

  const firstChoice = Array.isArray(value.choices)
    ? value.choices[0]
    : undefined;
  if (isRecord(firstChoice)) {
    const messageText = isRecord(firstChoice.message)
      ? getStringProperty(firstChoice.message, "content")
      : undefined;
    const choiceText = messageText ?? getStringProperty(firstChoice, "text");
    if (choiceText !== undefined) {
      return choiceText;
    }
  }

  return JSON.stringify(value, null, 2);
}

function getStringProperty(
  record: UnknownRecord,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}
