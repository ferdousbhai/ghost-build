export declare const XAI_DEFAULT_COMPACTION_TIMEOUT_MS = 30000;
export type XaiResponsesInputItem = Record<string, unknown>;
export type XaiNativeUsage = Readonly<{
    cacheReadInputTokens: number;
    costUsdTicks: number | null;
    inputTokens: number;
    outputTokens: number;
    serverSideToolCalls: number;
    totalTokens: number;
}>;
export type XaiCompactionUsage = XaiNativeUsage & Readonly<{
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
    path: "/responses/compact" | "/tokenize-text";
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
    countInputTokens: (input: {
        items: readonly XaiResponsesInputItem[];
        model: string;
    }) => Promise<number>;
    shouldCompactInput: (input: {
        hardLimitTokens: number;
        headroomTokens?: number;
        items: readonly XaiResponsesInputItem[];
        knownTokens?: number;
        model: string;
    }) => Promise<boolean>;
}>;
export declare function createXaiCompactionAdapter(options: {
    request: XaiCompactionTransport;
    timeoutMs?: number;
}): XaiCompactionAdapter;
export declare function readXaiResponseInput(requestBody: unknown): XaiResponsesInputItem[] | null;
export declare function readXaiCompletedResponseOutput(rawChunk: unknown): XaiResponsesInputItem[] | null;
export declare function buildXaiCompactionInput(step: Readonly<{
    input: readonly XaiResponsesInputItem[];
    output: readonly XaiResponsesInputItem[];
}>): XaiResponsesInputItem[];
export declare function parseXaiNativeUsage(value: unknown): XaiNativeUsage | null;
//# sourceMappingURL=xai.d.ts.map