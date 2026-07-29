import { lazy, memo, Suspense, type ReactNode } from 'react';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { editToolParameters } from 'ghostbuild-agent/tools/edit';
import { writeFileParameters } from 'ghostbuild-agent/tools/writeFile';
import { loggingSafeParse } from 'ghostbuild-agent/utils/zodUtil';
import { DeploymentApproval } from './DeploymentApproval.client';
import { parsePendingDeploymentApproval } from '~/lib/deployment-approval';
import { isGhostbuildToolResult, toolResultSummary } from 'ghostbuild-agent/tool-result';

const ToolViewResult = lazy(() => import('./ToolViewResult').then((module) => ({ default: module.ToolViewResult })));
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
      return <StructuredResultTool invocation={invocation} />;
    case 'validateProject':
      return <StructuredResultTool invocation={invocation} />;
    case 'view':
      return (
        <Suspense fallback={null}>
          <ToolViewResult invocation={invocation} />
        </Suspense>
      );
    case 'edit':
      return <EditTool invocation={invocation} />;
    case 'writeFile':
      return <WriteFileTool invocation={invocation} />;
    case 'lookupDocs':
      return (
        <Suspense fallback={null}>
          <ToolLookupDocsResult invocation={invocation} />
        </Suspense>
      );
    case 'listFiles':
    case 'searchText':
      return <StructuredResultTool invocation={invocation} />;
    default:
      return <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(invocation, null, 2)}</pre>;
  }
});

function DeploymentApprovalForResult({ result }: { result: unknown }) {
  const deployment = parsePendingDeploymentApproval(result);
  return deployment ? <DeploymentApproval deployment={deployment} /> : null;
}

function EditTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'edit' || invocation.state === 'partial-call') {
    return null;
  }
  const args = loggingSafeParse(editToolParameters, invocation.args);
  if (!args.success) {
    return null;
  }
  return (
    <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
      <div className="space-y-4 p-4">
        <div className="space-y-2 overflow-x-auto">
          {args.data.edits.map((edit, index) => (
            <div key={index} className="space-y-2">
              <pre className="text-bolt-elements-icon-error">{edit.old}</pre>
              <pre className="text-bolt-elements-icon-success">{edit.new}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WriteFileTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'writeFile' || invocation.state === 'partial-call') {
    return null;
  }
  const args = loggingSafeParse(writeFileParameters, invocation.args);
  return args.success ? (
    <ResultFrame>
      <pre>{args.data.content}</pre>
    </ResultFrame>
  ) : null;
}

function StructuredResultTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (isToolInvocationInProgress(invocation)) {
    return null;
  }
  if (!isGhostbuildToolResult(invocation.result)) {
    return <ResultFrame>{toolResultSummary(invocation.result)}</ResultFrame>;
  }
  return (
    <ResultFrame>
      <div className="space-y-2">
        <div>{invocation.result.summary}</div>
        {invocation.result.coverage ? (
          <pre className="whitespace-pre-wrap">{JSON.stringify(invocation.result.coverage, null, 2)}</pre>
        ) : null}
        {invocation.result.data ? (
          <pre className="whitespace-pre-wrap">{JSON.stringify(invocation.result.data, null, 2)}</pre>
        ) : null}
      </div>
    </ResultFrame>
  );
}

function ResultFrame({ children }: { children: ReactNode }) {
  return (
    <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
      <div className="max-h-[400px] overflow-auto p-4">{children}</div>
    </div>
  );
}
