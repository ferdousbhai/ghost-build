export { XAI_DEFAULT_COMPACTION_TIMEOUT_MS, buildXaiCompactionInput, createXaiCompactionAdapter, parseXaiNativeUsage, readXaiCompletedResponseOutput, readXaiResponseInput, type XaiCompactionAdapter, type XaiCompactionResult, type XaiCompactionTransport, type XaiCompactionTransportRequest, type XaiCompactionUsage, type XaiNativeUsage, type XaiResponsesInputItem, } from "./xai.js";
export type ConversationCompactionAction = "none" | "background" | "blocking";
export declare class ConversationCompactionSupersededError extends Error {
    name: string;
    constructor();
}
export declare class ConversationCompactionLimitError extends Error {
    readonly replacementTokens: number;
    readonly hardLimitTokens: number;
    readonly headroomTokens: number;
    readonly code: "conversation_compaction_limit";
    name: string;
    constructor(replacementTokens: number, hardLimitTokens: number, headroomTokens: number);
}
export type ConversationCompactionPolicy = Readonly<{
    proactiveTokens: number;
    hardLimitTokens: number;
    headroomTokens?: number;
}>;
export type ConversationCompactionCountRequest<Message, Context> = Readonly<{
    context: Context | undefined;
    messages: readonly Message[];
}>;
export type ConversationCompactionSnapshotRequest<Message, Context> = Readonly<{
    context: Context | undefined;
    inputTokens: number;
    messages: readonly Message[];
    sequence: number;
}>;
export type ScheduledConversationCompaction<Snapshot> = Readonly<{
    run: () => Promise<Snapshot>;
    sequence: number;
}>;
export type ConversationCompactionControllerOptions<Message, Snapshot, Context = undefined> = Readonly<{
    applySnapshot: (input: Readonly<{
        sequence: number;
        snapshot: Snapshot;
    }>) => readonly Message[];
    countInputTokens: (input: ConversationCompactionCountRequest<Message, Context>) => Promise<number>;
    createSnapshot: (input: ConversationCompactionSnapshotRequest<Message, Context>) => Promise<Snapshot>;
    messagesEqual?: (left: Message, right: Message) => boolean;
    policy: ConversationCompactionPolicy;
    scheduleCompaction?: (input: ScheduledConversationCompaction<Snapshot>) => Promise<void>;
}>;
export declare function decideConversationCompaction(input: Readonly<{
    estimatedTokens: number;
    pending?: boolean;
    policy: ConversationCompactionPolicy;
}>): ConversationCompactionAction;
export declare function createConversationCompactionController<Message, Snapshot, Context = undefined>(options: ConversationCompactionControllerOptions<Message, Snapshot, Context>): {
    latestBlockingSnapshot: () => Snapshot | null;
    /** @deprecated Use latestBlockingSnapshot; background snapshots are persisted by the scheduler. */
    latestSnapshot: () => Snapshot | null;
    pending: () => boolean;
    prepareMessages: (fullMessages: readonly Message[], context?: Context) => Promise<Message[]>;
    snapshotSequence: () => number;
};
export declare function conversationCompactionKey(input: Readonly<{
    scope: string;
    throughId: string;
    revision?: number | string;
}>): string;
export declare function canApplyConversationCompaction(input: Readonly<{
    expectedFromId: string;
    expectedThroughId: string;
    currentMessageIds: readonly string[];
    currentThroughId?: string | null;
}>): boolean;
//# sourceMappingURL=index.d.ts.map