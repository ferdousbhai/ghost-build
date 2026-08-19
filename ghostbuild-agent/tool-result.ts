export type ToolResultCoverage = {
  complete: boolean;
  start: number;
  end: number;
  total: number;
  nextCursor?: string;
};

export type GhostbuildToolResult<T = unknown> = {
  version: 1;
  ok: boolean;
  summary: string;
  data?: T;
  coverage?: ToolResultCoverage;
};

export function toolSuccess<T>(summary: string, data?: T, coverage?: ToolResultCoverage): GhostbuildToolResult<T> {
  return toolResult(true, summary, data, coverage);
}

export function toolFailure<T>(summary: string, data?: T, coverage?: ToolResultCoverage): GhostbuildToolResult<T> {
  return toolResult(false, summary, data, coverage);
}

function toolResult<T>(ok: boolean, summary: string, data?: T, coverage?: ToolResultCoverage): GhostbuildToolResult<T> {
  const result: GhostbuildToolResult<T> = { version: 1, ok, summary };
  if (data !== undefined) {
    result.data = data;
  }
  if (coverage) {
    result.coverage = coverage;
  }
  return result;
}

export function isGhostbuildToolResult(value: unknown): value is GhostbuildToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'ok' in value &&
    typeof value.ok === 'boolean' &&
    'summary' in value &&
    typeof value.summary === 'string'
  );
}

export function toolResultContent(value: unknown): string | undefined {
  if (!isGhostbuildToolResult(value)) {
    return undefined;
  }
  const { data } = value;
  if (typeof data !== 'object' || data === null || !('content' in data)) {
    return undefined;
  }
  return typeof data.content === 'string' ? data.content : undefined;
}

export function toolResultSummary(value: unknown): string {
  if (isGhostbuildToolResult(value)) {
    return value.summary;
  }
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

export function toolResultSucceeded(value: unknown): boolean {
  if (isGhostbuildToolResult(value)) {
    return value.ok;
  }
  if (typeof value === 'object' && value !== null) {
    if ('error' in value && typeof value.error === 'string') {
      return false;
    }
    if ('exitCode' in value && typeof value.exitCode === 'number') {
      return value.exitCode === 0;
    }
  }
  return true;
}
