export type ToolActivityStatus = 'pending' | 'running' | 'complete' | 'aborted';

export type ToolStatus = Record<string, ToolActivityStatus>;

export type StreamStatus = 'streaming' | 'submitted' | 'ready' | 'error';

export function isStreamStatusActive(status: StreamStatus): boolean {
  return status === 'streaming' || status === 'submitted';
}

export function isToolActivityStatusActive(status: ToolActivityStatus): boolean {
  return status === 'pending' || status === 'running';
}
