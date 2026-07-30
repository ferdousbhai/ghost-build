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
  return {
    version: 1,
    ok,
    summary,
    ...(data === undefined ? {} : { data }),
    ...(coverage ? { coverage } : {}),
  };
}

export function isGhostbuildToolResult(value: unknown): value is GhostbuildToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { ok?: unknown }).ok === 'boolean' &&
    typeof (value as { summary?: unknown }).summary === 'string'
  );
}

export function toolResultContent(value: unknown): string | undefined {
  if (!isGhostbuildToolResult(value) || typeof value.data !== 'object' || value.data === null) {
    return undefined;
  }
  const content = (value.data as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
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
  return typeof value !== 'string' || !value.startsWith('Error:');
}
