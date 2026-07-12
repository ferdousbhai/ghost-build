import type { MapStore } from 'nanostores';
import type { ArtifactAction } from 'ghostbuild-agent/types';

export type ActionStatus = 'pending' | 'running' | 'complete' | 'aborted' | 'failed';

export function isActionStatusActive(status: ActionStatus): boolean {
  return status === 'pending' || status === 'running';
}

type BaseActionState = ArtifactAction & {
  status: Exclude<ActionStatus, 'failed'>;
  abort: () => void;
  executed: boolean;
  abortSignal: AbortSignal;
};

type FailedActionState = ArtifactAction &
  Omit<BaseActionState, 'status'> & {
    status: Extract<ActionStatus, 'failed'>;
    error: string;
  };

export type ActionState = (BaseActionState | FailedActionState) & { isEdit?: boolean };

type BaseActionUpdate = Partial<Pick<BaseActionState, 'status' | 'abort' | 'executed' | 'content'>>;

export type ActionStateUpdate =
  BaseActionUpdate | (Omit<BaseActionUpdate, 'status'> & { status: 'failed'; error: string }) | { output: string };

export type ActionsMap = MapStore<Record<string, ActionState>>;

export type ActionRunnerWorkspace = {
  hasFile(path: string): boolean;
  setGeneratedFileContent(path: string, content: string): void;
};
