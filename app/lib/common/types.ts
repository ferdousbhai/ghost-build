import type { ActionStatus } from '~/lib/runtime/action-runner/types';

export type ToolStatus = Record<string, ActionStatus>;

export type StreamStatus = 'streaming' | 'submitted' | 'ready' | 'error';

export function isStreamStatusActive(status: StreamStatus): boolean {
  return status === 'streaming' || status === 'submitted';
}
