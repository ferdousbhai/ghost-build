import { lazy, memo, Suspense, useEffect } from 'react';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { isGhostbuildToolResult, toolResultSucceeded, toolResultSummary } from 'ghostbuild-agent/tool-result';
import { ToolResultFrame } from './ToolResultFrame';
import { captureProductEvent } from '~/lib/telemetry.client';

const ToolLookupDocsResult = lazy(() =>
  import('./ToolLookupDocsResult').then((module) => ({ default: module.ToolLookupDocsResult })),
);

export const ToolUseContents = memo(function ToolUseContents({ invocation }: { invocation: GhostbuildToolInvocation }) {
  switch (invocation.toolName) {
    case 'deploy':
      return <StructuredResultTool invocation={invocation} />;
    case 'npmInstall':
    case 'validateProject':
    case 'ls':
    case 'exec':
    case 'read':
      return <StructuredResultTool invocation={invocation} />;
    case 'edit':
    case 'write':
      return <StructuredResultTool invocation={invocation} />;
    case 'lookupDocs':
      return (
        <Suspense fallback={null}>
          <ToolLookupDocsResult invocation={invocation} />
        </Suspense>
      );
    default:
      return <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(invocation, null, 2)}</pre>;
  }
});

function StructuredResultTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  const complete = !isToolInvocationInProgress(invocation);
  const succeeded = invocation.state === 'output-available' && toolResultSucceeded(invocation.output);
  const validation =
    invocation.state === 'output-available' &&
    typeof invocation.output === 'object' &&
    invocation.output !== null &&
    'validation' in invocation.output
      ? invocation.output.validation
      : invocation.toolName === 'validateProject'
        ? invocation.output
        : undefined;
  const validationSucceeded = isGhostbuildToolResult(validation) && validation.ok;
  useEffect(() => {
    if (!complete) {
      return;
    }
    void captureProductEvent('first_tool_completed', {
      outcome: succeeded ? 'success' : invocation.state === 'output-denied' ? 'cancelled' : 'failure',
    });
    if (validationSucceeded) {
      void captureProductEvent('validation_succeeded', { outcome: 'success' });
    }
  }, [complete, invocation.state, invocation.toolCallId, succeeded, validationSucceeded]);

  if (isToolInvocationInProgress(invocation)) {
    return null;
  }
  if (invocation.state === 'output-error') {
    return <ToolResultFrame>{invocation.errorText}</ToolResultFrame>;
  }
  if (invocation.state === 'output-denied') {
    return <ToolResultFrame>{invocation.approval?.reason ?? 'Tool execution was denied.'}</ToolResultFrame>;
  }
  if (!isGhostbuildToolResult(invocation.output)) {
    return <ToolResultFrame>{toolResultSummary(invocation.output)}</ToolResultFrame>;
  }
  return (
    <ToolResultFrame>
      <div className="space-y-2">
        <div>{invocation.output.summary}</div>
        {invocation.output.coverage !== undefined ? (
          <pre className="whitespace-pre-wrap">{JSON.stringify(invocation.output.coverage, null, 2)}</pre>
        ) : null}
        {invocation.output.data !== undefined ? (
          <pre className="whitespace-pre-wrap">{JSON.stringify(invocation.output.data, null, 2)}</pre>
        ) : null}
      </div>
    </ToolResultFrame>
  );
}
