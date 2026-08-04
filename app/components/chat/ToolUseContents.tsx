import { lazy, memo, Suspense } from 'react';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { DeploymentApproval } from './DeploymentApproval.client';
import { parsePendingDeploymentApproval } from '~/lib/deployment-approval';
import { isGhostbuildToolResult, toolResultSummary } from 'ghostbuild-agent/tool-result';
import { ToolResultFrame } from './ToolResultFrame';

const ToolLookupDocsResult = lazy(() =>
  import('./ToolLookupDocsResult').then((module) => ({ default: module.ToolLookupDocsResult })),
);

export const ToolUseContents = memo(function ToolUseContents({ invocation }: { invocation: GhostbuildToolInvocation }) {
  switch (invocation.toolName) {
    case 'deploy':
      return (
        <>
          <StructuredResultTool invocation={invocation} />
          <DeploymentApprovalForResult result={invocation.result} />
        </>
      );
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

function DeploymentApprovalForResult({ result }: { result: unknown }) {
  const deployment = parsePendingDeploymentApproval(result);
  return deployment ? <DeploymentApproval deployment={deployment} /> : null;
}

function StructuredResultTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (isToolInvocationInProgress(invocation)) {
    return null;
  }
  if (!isGhostbuildToolResult(invocation.result)) {
    return <ToolResultFrame>{toolResultSummary(invocation.result)}</ToolResultFrame>;
  }
  return (
    <ToolResultFrame>
      <div className="space-y-2">
        <div>{invocation.result.summary}</div>
        {invocation.result.coverage !== undefined ? (
          <pre className="whitespace-pre-wrap">{JSON.stringify(invocation.result.coverage, null, 2)}</pre>
        ) : null}
        {invocation.result.data !== undefined ? (
          <pre className="whitespace-pre-wrap">{JSON.stringify(invocation.result.data, null, 2)}</pre>
        ) : null}
      </div>
    </ToolResultFrame>
  );
}
