import type { ActionStatus } from '~/lib/runtime/action-runner';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';

export type GhostbuildToolName = keyof GhostbuildToolSet;

export type ToolStatus = Record<string, ActionStatus>;

export type StreamStatus = 'streaming' | 'submitted' | 'ready' | 'error';

export function isStreamStatusActive(status: StreamStatus): boolean {
  return status === 'streaming' || status === 'submitted';
}
