import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { toolResultContent, toolResultSucceeded, toolResultSummary } from 'ghostbuild-agent/tool-result';
import { Markdown } from './Markdown';
import { ToolResultFrame } from './ToolResultFrame';

export function ToolLookupDocsResult({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'lookupDocs' || isToolInvocationInProgress(invocation)) {
    return null;
  }
  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText}</ToolResultFrame>;
  }
  if (invocation.state === 'output-denied') {
    return <ToolResultFrame>{invocation.approval.reason ?? 'Documentation lookup was denied.'}</ToolResultFrame>;
  }
  const resultText = toolResultContent(invocation.output) ?? toolResultSummary(invocation.output);
  return !toolResultSucceeded(invocation.output) ? (
    <ToolResultFrame>
      <pre>{resultText}</pre>
    </ToolResultFrame>
  ) : (
    <ToolResultFrame>
      <Markdown>{resultText}</Markdown>
    </ToolResultFrame>
  );
}
