export { XAI_DEFAULT_COMPACTION_TIMEOUT_MS, buildXaiCompactionInput, createXaiCompactionAdapter, parseXaiNativeUsage, readXaiCompletedResponseOutput, readXaiResponseInput, } from "./xai.js";
export class ConversationCompactionSupersededError extends Error {
    name = "ConversationCompactionSuperseded";
    constructor() {
        super("Conversation compaction was superseded by newer history");
    }
}
export class ConversationCompactionLimitError extends Error {
    replacementTokens;
    hardLimitTokens;
    headroomTokens;
    code = "conversation_compaction_limit";
    name = "ConversationCompactionLimitError";
    constructor(replacementTokens, hardLimitTokens, headroomTokens) {
        super(`Compacted conversation still requires ${saturatingAdd(replacementTokens, headroomTokens)} projected tokens, at or above the ${hardLimitTokens}-token hard limit`);
        this.replacementTokens = replacementTokens;
        this.hardLimitTokens = hardLimitTokens;
        this.headroomTokens = headroomTokens;
    }
}
export function decideConversationCompaction(input) {
    assertPolicy(input.policy);
    const estimated = nonNegativeInteger(input.estimatedTokens, "estimatedTokens");
    const projected = saturatingAdd(estimated, input.policy.headroomTokens ?? 0);
    if (projected >= input.policy.hardLimitTokens)
        return "blocking";
    if (projected >= input.policy.proactiveTokens && !input.pending) {
        return "background";
    }
    return "none";
}
export function createConversationCompactionController(options) {
    assertPolicy(options.policy);
    const messagesEqual = options.messagesEqual ?? Object.is;
    let observedMessages = null;
    let effectiveMessages = null;
    let latestSnapshot = null;
    let nextSequence = 0;
    let pendingSequence = null;
    let branchRevision = 0;
    let preparationTail = Promise.resolve();
    const prepareMessagesOnce = async (fullMessages, context) => {
        if (observedMessages === null ||
            effectiveMessages === null ||
            !isMessagePrefix(observedMessages, fullMessages, messagesEqual)) {
            observedMessages = [...fullMessages];
            effectiveMessages = [...fullMessages];
            latestSnapshot = null;
            pendingSequence = null;
            branchRevision += 1;
        }
        else if (fullMessages.length > observedMessages.length) {
            effectiveMessages.push(...fullMessages.slice(observedMessages.length));
            observedMessages = [...fullMessages];
        }
        const inputTokens = nonNegativeInteger(await options.countInputTokens({
            context,
            messages: effectiveMessages,
        }), "inputTokens");
        const action = decideConversationCompaction({
            estimatedTokens: inputTokens,
            pending: pendingSequence !== null,
            policy: options.policy,
        });
        if (action === "none")
            return [...effectiveMessages];
        if (action === "background" && !options.scheduleCompaction) {
            return [...effectiveMessages];
        }
        const sequence = nextSequence + 1;
        nextSequence = sequence;
        const sourceMessages = [...effectiveMessages];
        const sourceBranchRevision = branchRevision;
        const createSnapshot = async () => {
            if (sourceBranchRevision !== branchRevision ||
                sequence !== nextSequence) {
                throw new ConversationCompactionSupersededError();
            }
            const snapshot = await options.createSnapshot({
                context,
                inputTokens,
                messages: sourceMessages,
                sequence,
            });
            if (sourceBranchRevision !== branchRevision ||
                sequence !== nextSequence) {
                throw new ConversationCompactionSupersededError();
            }
            return snapshot;
        };
        if (action === "background" && options.scheduleCompaction) {
            pendingSequence = sequence;
            const run = async () => {
                if (sourceBranchRevision !== branchRevision ||
                    sequence !== nextSequence) {
                    throw new ConversationCompactionSupersededError();
                }
                pendingSequence = sequence;
                try {
                    return await createSnapshot();
                }
                catch (error) {
                    if (pendingSequence === sequence)
                        pendingSequence = null;
                    throw error;
                }
            };
            try {
                await options.scheduleCompaction({ run, sequence });
            }
            catch (error) {
                if (pendingSequence === sequence)
                    pendingSequence = null;
                throw error;
            }
            return [...effectiveMessages];
        }
        const snapshot = await createSnapshot();
        const replacement = options.applySnapshot({ sequence, snapshot });
        const replacementMessages = [...replacement];
        const replacementTokens = nonNegativeInteger(await options.countInputTokens({
            context,
            messages: replacementMessages,
        }), "replacementTokens");
        const headroomTokens = options.policy.headroomTokens ?? 0;
        if (saturatingAdd(replacementTokens, headroomTokens) >=
            options.policy.hardLimitTokens) {
            throw new ConversationCompactionLimitError(replacementTokens, options.policy.hardLimitTokens, headroomTokens);
        }
        latestSnapshot = snapshot;
        effectiveMessages = replacementMessages;
        return [...effectiveMessages];
    };
    const prepareMessages = (fullMessages, context) => {
        const messages = [...fullMessages];
        const prepared = preparationTail.then(() => prepareMessagesOnce(messages, context));
        preparationTail = prepared.then(() => undefined, () => undefined);
        return prepared;
    };
    const latestBlockingSnapshot = () => latestSnapshot;
    return {
        latestBlockingSnapshot,
        /** @deprecated Use latestBlockingSnapshot; background snapshots are persisted by the scheduler. */
        latestSnapshot: latestBlockingSnapshot,
        pending: () => pendingSequence !== null,
        prepareMessages,
        snapshotSequence: () => nextSequence,
    };
}
export function conversationCompactionKey(input) {
    const scope = requiredKeyPart(input.scope, "scope");
    const throughId = requiredKeyPart(input.throughId, "throughId");
    const revision = input.revision === undefined
        ? "0"
        : requiredKeyPart(String(input.revision), "revision");
    return `conversation-compaction:${encodeURIComponent(scope)}:${encodeURIComponent(throughId)}:${encodeURIComponent(revision)}`;
}
export function canApplyConversationCompaction(input) {
    const start = input.currentMessageIds.indexOf(input.expectedFromId);
    const end = input.currentMessageIds.indexOf(input.expectedThroughId);
    if (start < 0 || end < start)
        return false;
    if (!input.currentThroughId)
        return true;
    const currentEnd = input.currentMessageIds.indexOf(input.currentThroughId);
    return currentEnd < end;
}
function isMessagePrefix(previous, current, messagesEqual) {
    if (previous.length > current.length)
        return false;
    return previous.every((message, index) => {
        const currentMessage = current[index];
        return (currentMessage !== undefined && messagesEqual(message, currentMessage));
    });
}
function assertPolicy(policy) {
    const proactive = nonNegativeInteger(policy.proactiveTokens, "proactiveTokens");
    const hard = nonNegativeInteger(policy.hardLimitTokens, "hardLimitTokens");
    nonNegativeInteger(policy.headroomTokens ?? 0, "headroomTokens");
    if (proactive < 1 || hard <= proactive) {
        throw new Error("Compaction policy requires 0 < proactiveTokens < hardLimitTokens");
    }
}
function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
    return value;
}
function saturatingAdd(left, right) {
    return left > Number.MAX_SAFE_INTEGER - right
        ? Number.MAX_SAFE_INTEGER
        : left + right;
}
function requiredKeyPart(value, name) {
    const normalized = value.trim();
    if (!normalized)
        throw new Error(`${name} is required`);
    return normalized;
}
//# sourceMappingURL=index.js.map