import { pruneMessages, type ModelMessage } from 'ai';
import { estimateStringTokens } from 'agents/experimental/memory/utils';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { MAX_ESTIMATED_MODEL_INPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import type { GhostbuildToolName, GhostbuildToolSet } from 'ghostbuild-agent/types';
import { assembleCompactedContext, compactContext, type ContextCompaction } from './context-compaction';
import { cleanupAssistantMessages } from './message-conversion';
import { injectTurnContext } from './turn-context';
import { serializeWorkersAiToolDefinitions, type AgentToolChoice } from './workers-ai-tools';

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
};

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

/** Build the actual provider input, compacting once above 100K without dropping transcript history. */
export async function prepareModelInput(args: {
  messages: GhostbuildMessage[];
  turnContext?: ChatTurnContext;
  currentCompaction?: ContextCompaction | null;
  summarize: (prompt: string) => Promise<string>;
  systemPrompts: string[];
  tools: GhostbuildToolSet;
  toolChoice: AgentToolChoice;
  activeTools?: GhostbuildToolName[];
  logger?: ModelInputLogger;
}): Promise<PreparedModelInput> {
  let assembled = assembleCompactedContext(args.messages, args.currentCompaction);
  let promptMessages = injectTurnContext(assembled.messages, args.turnContext);
  let modelInput = await assembleModelInput(promptMessages, args);

  if (modelInput.estimatedTokens <= MAX_ESTIMATED_MODEL_INPUT_TOKENS) {
    return {
      ...modelInput,
      promptMessages,
      contextCompacted: assembled.overlayApplied,
      nextCompaction: null,
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
    });
  } catch (error) {
    args.logger?.warn('Automatic context compaction failed; preserving the full transcript', {
      error: error instanceof Error ? error.message : String(error),
      estimatedTokens: modelInput.estimatedTokens,
    });
    throw new ContextCompactionUnavailableError(error);
  }

  if (!nextCompaction) {
    throw new ModelInputBudgetExceededError(modelInput.estimatedTokens, MAX_ESTIMATED_MODEL_INPUT_TOKENS);
  }

  const tokensBefore = modelInput.estimatedTokens;
  const messagesBefore = assembled.messages.length;
  assembled = assembleCompactedContext(args.messages, nextCompaction);
  promptMessages = injectTurnContext(assembled.messages, args.turnContext);
  modelInput = await assembleModelInput(promptMessages, args);
  if (modelInput.estimatedTokens > MAX_ESTIMATED_MODEL_INPUT_TOKENS) {
    throw new ModelInputBudgetExceededError(modelInput.estimatedTokens, MAX_ESTIMATED_MODEL_INPUT_TOKENS);
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
  };
}

async function assembleModelInput(
  uiMessages: GhostbuildMessage[],
  args: Pick<Parameters<typeof prepareModelInput>[0], 'activeTools' | 'systemPrompts' | 'tools' | 'toolChoice'>,
): Promise<{ messages: ModelMessage[]; estimatedTokens: number }> {
  const history = pruneMessages({
    messages: await cleanupAssistantMessages(uiMessages, args.tools),
    reasoning: 'before-last-message',
    toolCalls: 'before-last-2-messages',
    emptyMessages: 'remove',
  });
  const messages: ModelMessage[] = [
    ...args.systemPrompts.map((content): ModelMessage => ({ role: 'system', content })),
    ...history,
  ];
  const estimatedTokens = estimateStringTokens(
    JSON.stringify({
      messages,
      activeTools: args.activeTools,
      tools: serializeWorkersAiToolDefinitions(args.tools, args.activeTools),
      toolChoice: args.toolChoice,
    }),
  );
  return { messages, estimatedTokens };
}
