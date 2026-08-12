import { decideConversationCompaction, type ConversationCompactionAction } from '~/lib/compaction';
import type { ModelMessage } from './message-conversion';
import { estimateStringTokens } from 'agents/experimental/memory/utils';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { MAX_ESTIMATED_MODEL_INPUT_TOKENS, MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';
import {
  assembleCompactedContext,
  compactContext,
  CONTEXT_COMPACTION_KEEP_RECENT_TOKENS,
  type ContextCompaction,
} from './context-compaction';
import { cleanupAssistantMessages } from './message-conversion';
import { injectTurnContext } from './turn-context';
import { serializeWorkersAiToolDefinitions } from './workers-ai-tools';

type ModelInputLogger = {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
};

type PreparedModelInput = {
  messages: ModelMessage[];
  promptMessages: GhostbuildMessage[];
  estimatedTokens: number;
  contextCompacted: boolean;
  nextCompaction: ContextCompaction | null;
  compactionAction: ConversationCompactionAction;
};

const COMPACTION_SAFETY_TOKENS = 4_096;

export function modelCompactionPolicy(contextWindow: number) {
  const hardLimitTokens = Math.min(
    MAX_ESTIMATED_MODEL_INPUT_TOKENS,
    Math.max(1, contextWindow - MODEL_MAX_OUTPUT_TOKENS - COMPACTION_SAFETY_TOKENS),
  );
  return {
    proactiveTokens: Math.max(1, hardLimitTokens - CONTEXT_COMPACTION_KEEP_RECENT_TOKENS),
    hardLimitTokens,
  };
}

export class ModelInputBudgetExceededError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly maximumEstimatedTokens: number,
  ) {
    super(
      `The system instructions, tools, and current turn need approximately ${estimatedTokens} input tokens; ` +
        `the conservative limit is ${maximumEstimatedTokens}. Shorten the current request or attached file changes.`,
    );
    this.name = 'ModelInputBudgetExceededError';
  }
}

export class ContextCompactionUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('This conversation needs automatic compaction, but its summary could not be generated. Please retry.');
    this.name = 'ContextCompactionUnavailableError';
  }
}

/** Build provider input, replacing older prompt messages with a summary as the configured limits approach. */
export async function prepareModelInput(args: {
  messages: GhostbuildMessage[];
  turnContext?: ChatTurnContext;
  currentCompaction?: ContextCompaction | null;
  compactionPending?: boolean;
  summarize: (prompt: string, signal?: AbortSignal) => Promise<string>;
  scheduleCompaction?: () => Promise<void>;
  signal?: AbortSignal;
  contextWindow: number;
  systemPrompts: string[];
  tools: GhostbuildToolSet;
  logger?: ModelInputLogger;
}): Promise<PreparedModelInput> {
  let assembled = assembleCompactedContext(args.messages, args.currentCompaction);
  let promptMessages = injectTurnContext(assembled.messages, args.turnContext);
  let modelInput = await assembleModelInput(promptMessages, args);
  const policy = modelCompactionPolicy(args.contextWindow);
  const compactionAction = decideConversationCompaction({
    estimatedTokens: modelInput.estimatedTokens,
    pending: args.compactionPending,
    policy,
  });

  if (compactionAction !== 'blocking') {
    if (compactionAction === 'background') {
      await args.scheduleCompaction?.();
    }
    return {
      ...modelInput,
      promptMessages,
      contextCompacted: assembled.overlayApplied,
      nextCompaction: null,
      compactionAction,
    };
  }

  args.logger?.info('Starting automatic Ghostbuild context compaction', {
    estimatedTokens: modelInput.estimatedTokens,
    messageCount: assembled.messages.length,
  });

  let nextCompaction: ContextCompaction | null;
  try {
    nextCompaction = await compactContext({
      messages: args.messages,
      current: args.currentCompaction,
      summarize: args.summarize,
      signal: args.signal,
    });
  } catch (error) {
    args.signal?.throwIfAborted();
    args.logger?.warn('Automatic context compaction failed; preserving the full transcript', {
      error: error instanceof Error ? error.message : String(error),
      estimatedTokens: modelInput.estimatedTokens,
    });
    throw new ContextCompactionUnavailableError(error);
  }

  if (!nextCompaction) {
    throw new ModelInputBudgetExceededError(modelInput.estimatedTokens, policy.hardLimitTokens);
  }

  const tokensBefore = modelInput.estimatedTokens;
  const messagesBefore = assembled.messages.length;
  assembled = assembleCompactedContext(args.messages, nextCompaction);
  promptMessages = injectTurnContext(assembled.messages, args.turnContext);
  modelInput = await assembleModelInput(promptMessages, args);
  if (modelInput.estimatedTokens >= policy.hardLimitTokens) {
    throw new ModelInputBudgetExceededError(modelInput.estimatedTokens, policy.hardLimitTokens);
  }

  args.logger?.info('Automatically compacted Ghostbuild context', {
    tokensBefore,
    tokensAfter: modelInput.estimatedTokens,
    messagesBefore,
    messagesAfter: assembled.messages.length,
  });

  return {
    ...modelInput,
    promptMessages,
    contextCompacted: true,
    nextCompaction,
    compactionAction,
  };
}

async function assembleModelInput(
  uiMessages: GhostbuildMessage[],
  args: Pick<Parameters<typeof prepareModelInput>[0], 'systemPrompts' | 'tools'>,
): Promise<{ messages: ModelMessage[]; estimatedTokens: number }> {
  const messages = cleanupAssistantMessages(uiMessages);
  const estimatedTokens = estimateStringTokens(
    JSON.stringify({
      instructions: args.systemPrompts,
      messages,
      tools: serializeWorkersAiToolDefinitions(args.tools),
      toolChoice: 'auto',
    }),
  );
  return { messages, estimatedTokens };
}
