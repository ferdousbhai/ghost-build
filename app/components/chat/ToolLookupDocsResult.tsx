import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { isGhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { Markdown } from './Markdown';
import { ToolResultFrame } from './ToolResultFrame';

export function ToolLookupDocsResult({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'lookupDocs' || isToolInvocationInProgress(invocation)) {
    return null;
  }
  const resultText =
    structuredContent(invocation.result) ?? (typeof invocation.result === 'string' ? invocation.result : '');
  return resultText.startsWith('Error:') ? (
    <ToolResultFrame>
      <pre>{resultText}</pre>
    </ToolResultFrame>
  ) : (
    <ToolResultFrame>
      <Markdown html>{resultText}</Markdown>
    </ToolResultFrame>
  );
}

function structuredContent(result: unknown): string | undefined {
  if (!isGhostbuildToolResult(result) || typeof result.data !== 'object' || result.data === null) {
    return undefined;
  }
  const content = (result.data as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}
