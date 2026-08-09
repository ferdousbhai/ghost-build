export const XAI_DEFAULT_COMPACTION_TIMEOUT_MS = 30_000;

export type XaiResponsesInputItem = Record<string, unknown>;

export type XaiNativeUsage = Readonly<{
  cacheReadInputTokens: number;
  costUsdTicks: number | null;
  inputTokens: number;
  outputTokens: number;
  serverSideToolCalls: number;
  totalTokens: number;
}>;

export type XaiCompactionUsage = XaiNativeUsage &
  Readonly<{
    droppedMessageCount: number;
  }>;

export type XaiCompactionResult = Readonly<{
  /** Replay this output array verbatim as the prefix of the next Responses input. */
  items: readonly XaiResponsesInputItem[];
  usage: XaiCompactionUsage;
}>;

export type XaiCompactionTransportRequest = Readonly<{
  body: Readonly<Record<string, unknown>>;
  conversationId?: string;
  path: '/responses/compact' | '/tokenize-text';
  signal: AbortSignal;
}>;

/**
 * Application-owned authenticated transport.
 *
 * The consumer chooses its xAI or gateway base URL and supplies credentials.
 * This package owns only provider request bodies and response validation.
 */
export type XaiCompactionTransport = (request: XaiCompactionTransportRequest) => Promise<Response>;

export type XaiCompactionAdapter = Readonly<{
  compactInput: (input: {
    conversationId?: string;
    items: readonly XaiResponsesInputItem[];
    model: string;
  }) => Promise<XaiCompactionResult>;
  countInputTokens: (input: { items: readonly XaiResponsesInputItem[]; model: string }) => Promise<number>;
  shouldCompactInput: (input: {
    hardLimitTokens: number;
    headroomTokens?: number;
    items: readonly XaiResponsesInputItem[];
    knownTokens?: number;
    model: string;
  }) => Promise<boolean>;
}>;

export function createXaiCompactionAdapter(options: {
  request: XaiCompactionTransport;
  timeoutMs?: number;
}): XaiCompactionAdapter {
  const timeoutMs = positiveSafeInteger(options.timeoutMs ?? XAI_DEFAULT_COMPACTION_TIMEOUT_MS, 'timeoutMs');

  const countInputTokens: XaiCompactionAdapter['countInputTokens'] = async (input) => {
    const model = requiredString(input.model, 'model');
    const response = await requestWithTimeout(
      options.request,
      {
        body: {
          model,
          text: JSON.stringify(input.items),
        },
        path: '/tokenize-text',
      },
      timeoutMs,
      'xAI context token counting timed out',
    );
    await assertSuccessfulResponse(response, 'xAI context token counting');
    const tokenIds = asRecord(await response.json())?.token_ids;
    if (!Array.isArray(tokenIds)) {
      throw new Error('xAI context token counting returned no token IDs');
    }
    return tokenIds.length;
  };

  const compactInput: XaiCompactionAdapter['compactInput'] = async (input) => {
    const model = requiredString(input.model, 'model');
    if (input.items.length === 0) {
      throw new Error('Cannot compact an empty xAI context');
    }
    const response = await requestWithTimeout(
      options.request,
      {
        body: {
          model,
          input: input.items,
        },
        ...(input.conversationId && {
          conversationId: input.conversationId,
        }),
        path: '/responses/compact',
      },
      timeoutMs,
      'xAI context compaction timed out',
    );
    await assertSuccessfulResponse(response, 'xAI context compaction');

    const payload = asRecord(await response.json());
    const items = asInputItems(payload?.output);
    if (items?.length !== 1 || !readCompactionItem(items[0])) {
      throw new Error('xAI context compaction returned no valid compaction item');
    }
    const usage = parseXaiNativeUsage(payload?.usage);
    const droppedMessageCount = readNonNegativeSafeInteger(asRecord(payload?.usage)?.dropped_message_count);
    if (!usage || droppedMessageCount === null) {
      throw new Error('xAI context compaction returned invalid usage');
    }
    return {
      items,
      usage: {
        ...usage,
        droppedMessageCount,
      },
    };
  };

  const shouldCompactInput: XaiCompactionAdapter['shouldCompactInput'] = async (input) => {
    const hardLimitTokens = positiveSafeInteger(input.hardLimitTokens, 'hardLimitTokens');
    const knownTokens = optionalNonNegativeSafeInteger(input.knownTokens, 'knownTokens');
    const headroomTokens = optionalNonNegativeSafeInteger(input.headroomTokens, 'headroomTokens');
    if (saturatingAdd(knownTokens, headroomTokens) >= hardLimitTokens) {
      return true;
    }

    // One byte cannot require more than one byte-fallback token. Avoid a
    // provider request when even that conservative bound fits.
    if (
      saturatingAdd(saturatingAdd(knownTokens, serializedByteLength(input.items)), headroomTokens) < hardLimitTokens
    ) {
      return false;
    }

    try {
      const itemTokens = await countInputTokens(input);
      return saturatingAdd(saturatingAdd(knownTokens, itemTokens), headroomTokens) >= hardLimitTokens;
    } catch {
      // Failing closed avoids sending a context that may exceed the provider's
      // hard limit when precise preflight counting is unavailable.
      return true;
    }
  };

  return {
    compactInput,
    countInputTokens,
    shouldCompactInput,
  };
}

export function readXaiResponseInput(requestBody: unknown): XaiResponsesInputItem[] | null {
  return asInputItems(asRecord(requestBody)?.input);
}

export function readXaiCompletedResponseOutput(rawChunk: unknown): XaiResponsesInputItem[] | null {
  return asInputItems(readCompletedResponse(rawChunk)?.output);
}

export function buildXaiCompactionInput(
  step: Readonly<{
    input: readonly XaiResponsesInputItem[];
    output: readonly XaiResponsesInputItem[];
  }>,
): XaiResponsesInputItem[] {
  return [...step.input.filter((item) => !isSystemInputItem(item)), ...step.output];
}

export function parseXaiNativeUsage(value: unknown): XaiNativeUsage | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const inputTokens = readNonNegativeSafeInteger(usage.input_tokens);
  const outputTokens = readNonNegativeSafeInteger(usage.output_tokens);
  const totalTokens = readNonNegativeSafeInteger(usage.total_tokens);
  const inputTokenDetails = usage.input_tokens_details === undefined ? null : asRecord(usage.input_tokens_details);
  const cacheReadInputTokens = readOptionalNonNegativeSafeInteger(inputTokenDetails?.cached_tokens, 0);
  const costUsdTicks = readOptionalNonNegativeSafeInteger(usage.cost_in_usd_ticks, null);
  const serverSideToolCalls = readOptionalNonNegativeSafeInteger(usage.num_server_side_tools_used, 0);
  if (
    inputTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    (usage.input_tokens_details !== undefined && !inputTokenDetails) ||
    cacheReadInputTokens === null ||
    (usage.cost_in_usd_ticks !== undefined && costUsdTicks === null) ||
    serverSideToolCalls === null ||
    totalTokens !== saturatingAdd(inputTokens, outputTokens)
  ) {
    return null;
  }
  return {
    cacheReadInputTokens,
    costUsdTicks,
    inputTokens,
    outputTokens,
    serverSideToolCalls,
    totalTokens,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asInputItems(value: unknown): XaiResponsesInputItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(asRecord);
  return items.every((item) => item !== null) ? (items as XaiResponsesInputItem[]) : null;
}

function readOptionalNonNegativeSafeInteger<T extends number | null>(
  value: unknown,
  missingValue: T,
): number | T | null {
  return value === undefined ? missingValue : readNonNegativeSafeInteger(value);
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function readCompletedResponse(rawChunk: unknown): Record<string, unknown> | null {
  const event = parseRawEvent(rawChunk);
  if (
    event?.type !== 'response.completed' &&
    event?.type !== 'response.incomplete' &&
    event?.type !== 'response.done'
  ) {
    return null;
  }
  return asRecord(event.response);
}

function parseRawEvent(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function isSystemInputItem(item: XaiResponsesInputItem): boolean {
  return item.role === 'system' || item.role === 'developer';
}

function readCompactionItem(value: unknown): XaiResponsesInputItem | null {
  const item = asRecord(value);
  return item?.type === 'compaction' &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.encrypted_content === 'string' &&
    item.encrypted_content.length > 0
    ? item
    : null;
}

async function requestWithTimeout(
  request: XaiCompactionTransport,
  input: Omit<XaiCompactionTransportRequest, 'signal'>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(timeoutMessage);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([request({ ...input, signal: controller.signal }), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function assertSuccessfulResponse(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const detail = (await response.text().catch(() => '')).slice(0, 1_000);
  throw new Error(`${operation} failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function optionalNonNegativeSafeInteger(value: number | undefined, name: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function readNonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function saturatingAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function requiredString(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
