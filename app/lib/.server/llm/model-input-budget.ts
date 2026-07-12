import { pruneMessages, type ModelMessage } from 'ai';
import { COMPACTION_PREFIX, estimateStringTokens } from 'agents/experimental/memory/utils';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { MAX_ESTIMATED_MODEL_INPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import type { GhostbuildToolName, GhostbuildToolSet } from 'ghostbuild-agent/types';
import { cleanupAssistantMessages } from './message-conversion';
import { serializeWorkersAiToolDefinitions, type AgentToolChoice } from './workers-ai-tools';

const PROTECTED_HEAD_MESSAGES = 3;

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

type BoundedModelInput = {
  messages: ModelMessage[];
  estimatedTokens: number;
  reduced: boolean;
  droppedMessageCount: number;
};

export async function prepareBoundedModelInput(args: {
  uiMessages: GhostbuildMessage[];
  systemPrompts: string[];
  tools: GhostbuildToolSet;
  toolChoice: AgentToolChoice;
  activeTools?: GhostbuildToolName[];
  maximumEstimatedTokens?: number;
}): Promise<BoundedModelInput> {
  const maximumEstimatedTokens = args.maximumEstimatedTokens ?? MAX_ESTIMATED_MODEL_INPUT_TOKENS;
  const full = await assemble(args.uiMessages, args);
  if (full.estimatedTokens <= maximumEstimatedTokens) {
    return { ...full, reduced: false, droppedMessageCount: 0 };
  }

  const lastUserIndex = args.uiMessages.findLastIndex((message) => message.role === 'user');
  const requiredStart = lastUserIndex < 0 ? 0 : lastUserIndex;
  const requiredIndices = range(requiredStart, args.uiMessages.length);
  const preferredIndices = new Set<number>();
  for (let index = 0; index < Math.min(PROTECTED_HEAD_MESSAGES, requiredStart); index++) {
    preferredIndices.add(index);
  }
  for (let index = 0; index < requiredStart; index++) {
    if (args.uiMessages[index].id.startsWith(COMPACTION_PREFIX)) {
      preferredIndices.add(index);
    }
  }

  let baseIndices = [...preferredIndices, ...requiredIndices].sort((left, right) => left - right);
  let base = await assemble(selectMessages(args.uiMessages, baseIndices), args);
  if (base.estimatedTokens > maximumEstimatedTokens) {
    baseIndices = requiredIndices;
    base = await assemble(selectMessages(args.uiMessages, baseIndices), args);
  }
  if (base.estimatedTokens > maximumEstimatedTokens) {
    throw new ModelInputBudgetExceededError(base.estimatedTokens, maximumEstimatedTokens);
  }

  const baseSet = new Set(baseIndices);
  const optionalIndices = range(0, requiredStart).filter((index) => !baseSet.has(index));
  let low = 0;
  let high = optionalIndices.length;
  let bestIndices = baseIndices;
  let best = base;

  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const recent = optionalIndices.slice(optionalIndices.length - count);
    const candidateIndices = [...baseIndices, ...recent].sort((left, right) => left - right);
    const candidate = await assemble(selectMessages(args.uiMessages, candidateIndices), args);
    if (candidate.estimatedTokens <= maximumEstimatedTokens) {
      bestIndices = candidateIndices;
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }

  return {
    ...best,
    reduced: true,
    droppedMessageCount: args.uiMessages.length - bestIndices.length,
  };
}

async function assemble(
  uiMessages: GhostbuildMessage[],
  args: Pick<Parameters<typeof prepareBoundedModelInput>[0], 'activeTools' | 'systemPrompts' | 'tools' | 'toolChoice'>,
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
      tools: serializeWorkersAiToolDefinitions(args.tools),
      toolChoice: args.toolChoice,
    }),
  );
  return { messages, estimatedTokens };
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

function selectMessages(messages: GhostbuildMessage[], indices: number[]): GhostbuildMessage[] {
  return indices.map((index) => messages[index]);
}
