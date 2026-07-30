import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { toolResultContent, toolResultSucceeded, toolResultSummary } from 'ghostbuild-agent/tool-result';
import { Markdown } from './Markdown';
import { ToolResultFrame } from './ToolResultFrame';

export function ToolLookupDocsResult({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'lookupDocs' || isToolInvocationInProgress(invocation)) {
    return null;
  }
  const resultText = toolResultContent(invocation.result) ?? toolResultSummary(invocation.result);
  return !toolResultSucceeded(invocation.result) ? (
    <ToolResultFrame>
      <pre>{resultText}</pre>
    </ToolResultFrame>
  ) : (
    <ToolResultFrame>
      <Markdown html>{resultText}</Markdown>
    </ToolResultFrame>
  );
}
