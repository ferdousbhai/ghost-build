import type { ReactNode } from 'react';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { isGhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { Markdown } from './Markdown';

export function ToolLookupDocsResult({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'lookupDocs' || isToolInvocationInProgress(invocation)) {
    return null;
  }
  const resultText =
    structuredContent(invocation.result) ?? (typeof invocation.result === 'string' ? invocation.result : '');
  return resultText.startsWith('Error:') ? (
    <ResultFrame>
      <pre>{resultText}</pre>
    </ResultFrame>
  ) : (
    <ResultFrame>
      <Markdown html>{resultText}</Markdown>
    </ResultFrame>
  );
}

function structuredContent(result: unknown): string | undefined {
  if (!isGhostbuildToolResult(result) || typeof result.data !== 'object' || result.data === null) {
    return undefined;
  }
  const content = (result.data as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

function ResultFrame({ children }: { children: ReactNode }) {
  return (
    <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
      <div className="max-h-[400px] overflow-auto p-4">{children}</div>
    </div>
  );
}
