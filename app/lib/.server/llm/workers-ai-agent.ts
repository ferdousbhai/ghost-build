import type { PiStreamChunk } from './pi-stream';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

type UIMessageChunk = PiStreamChunk;
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import type { WorkersAiModelId } from '~/lib/workers-ai-model';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { ContextCompaction } from './context-compaction';
import type { WorkersAiAccountCredentials } from './provider';

type Messages = GhostbuildMessage[];
export interface WorkersAiAgentOptions {
  abortSignal?: AbortSignal;
  firstUserMessage: boolean;
  messages: Messages;
  modelId: WorkersAiModelId;
  turnContext?: ChatTurnContext;
  compaction: {
    current: ContextCompaction | null;
    pending: boolean;
    summarize: (prompt: string) => Promise<string>;
    save: (compaction: ContextCompaction) => void;
    schedule?: () => Promise<void>;
  };
  accountCredentials: WorkersAiAccountCredentials;
  sessionAffinity: string;
  workspace: BuilderWorkspaceApi;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
}

export async function workersAiAgent(options: WorkersAiAgentOptions): Promise<ReadableStream<UIMessageChunk>> {
  const { piAgentRunner } = await import('./pi-agent-runner');
  return piAgentRunner(options);
}
