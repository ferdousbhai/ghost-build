import { lazy, memo, Suspense, type ReactNode } from 'react';
import { useStore } from '@nanostores/react';
import { FileIcon } from '@radix-ui/react-icons';
import { FolderIcon } from '@heroicons/react/24/outline';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { editToolInputParameters } from 'ghostbuild-agent/tools/edit';
import { viewToolInputParameters } from 'ghostbuild-agent/tools/view';
import { writeFileParameters } from 'ghostbuild-agent/tools/writeFile';
import { path } from 'ghostbuild-agent/utils/path';
import { loggingSafeParse } from 'ghostbuild-agent/utils/zodUtil';
import type { ArtifactState } from '~/lib/stores/workbench-artifacts';
import { themeStore } from '~/lib/stores/theme';
import { normalizeCodeLanguage, type CodeTheme } from '~/lib/shiki.client';
import { Markdown } from './Markdown';
import { highlightTokenStyle, useHighlightedCode } from './useHighlightedCode';
import { DeploymentApproval } from './DeploymentApproval.client';
import { parsePendingDeploymentApproval } from '~/lib/deployment-approval';
import { isGhostbuildToolResult, toolResultSummary } from 'ghostbuild-agent/tool-result';

const ToolOutputTerminal = lazy(() =>
  import('./ToolOutputTerminal').then((module) => ({ default: module.ToolOutputTerminal })),
);

export const ToolUseContents = memo(function ToolUseContents({
  artifact,
  invocation,
}: {
  artifact: ArtifactState;
  invocation: GhostbuildToolInvocation;
}) {
  switch (invocation.toolName) {
    case 'deploy':
      return (
        <>
          <TerminalTool artifact={artifact} invocation={invocation} toolName="deploy" />
          <DeploymentApprovalForResult result={invocation.result} />
        </>
      );
    case 'npmInstall':
      return <TerminalTool artifact={artifact} invocation={invocation} toolName="npmInstall" />;
    case 'validateProject':
      return (
        <>
          <TerminalTool artifact={artifact} invocation={invocation} toolName="validateProject" />
          <StructuredResultTool invocation={invocation} />
        </>
      );
    case 'view':
      return <ViewTool invocation={invocation} />;
    case 'edit':
      return <EditTool invocation={invocation} />;
    case 'writeFile':
      return <WriteFileTool invocation={invocation} />;
    case 'lookupDocs':
      return <LookupDocsTool invocation={invocation} />;
    case 'listFiles':
    case 'searchText':
    case 'getDiagnostics':
      return <StructuredResultTool invocation={invocation} />;
    default:
      return <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(invocation, null, 2)}</pre>;
  }
});

function DeploymentApprovalForResult({ result }: { result: unknown }) {
  const deployment = parsePendingDeploymentApproval(result);
  return deployment ? <DeploymentApproval deployment={deployment} /> : null;
}

function TerminalTool({
  artifact,
  invocation,
  toolName,
}: {
  artifact: ArtifactState;
  invocation: GhostbuildToolInvocation;
  toolName: 'deploy' | 'npmInstall' | 'validateProject';
}) {
  if (invocation.toolName !== toolName) {
    throw new Error(`Terminal expected ${toolName}, received ${invocation.toolName}`);
  }
  const succeeded = !isGhostbuildToolResult(invocation.result) || invocation.result.ok;
  const visible =
    invocation.state === 'call' ||
    (toolName === 'deploy' && invocation.state === 'result') ||
    ((toolName === 'npmInstall' || toolName === 'validateProject') && invocation.state === 'result' && !succeeded);
  return visible ? (
    <Suspense fallback={null}>
      <ToolOutputTerminal artifact={artifact} invocation={invocation} />
    </Suspense>
  ) : null;
}

function ViewTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'view') {
    throw new Error('View tool can only render view invocations');
  }
  if (isToolInvocationInProgress(invocation)) {
    return null;
  }
  const structured = structuredContent(invocation.result);
  const resultText = structured ?? (typeof invocation.result === 'string' ? invocation.result : '');
  if (resultText.startsWith('Error:')) {
    return <ResultFrame>{resultText}</ResultFrame>;
  }
  if (resultText.startsWith('Directory:')) {
    return (
      <div className="text-content-primary space-y-1 rounded-lg border p-4 font-mono text-sm">
        {resultText
          .split('\n')
          .slice(1)
          .map((item, index) => {
            const isDirectory = item.includes('(dir)');
            const label = item.replace('(dir)', '').replace('(file)', '').replace('- ', '').trim();
            return (
              <div key={index} className="flex items-center gap-2">
                {isDirectory ? <FolderIcon className="size-4" /> : <FileIcon />}
                {label}
              </div>
            );
          })}
      </div>
    );
  }

  const lines = structured
    ? structured.split('\n')
    : resultText.split('\n').map((line) => line.split(':').slice(1).join(':'));
  const args = loggingSafeParse(viewToolInputParameters, invocation.args);
  const language = args.success ? normalizeCodeLanguage(path.extname(args.data.path)) : 'typescript';
  const structuredStartLine =
    isGhostbuildToolResult(invocation.result) && typeof invocation.result.data === 'object' && invocation.result.data
      ? (invocation.result.data as { pageLineStart?: unknown }).pageLineStart
      : undefined;
  const startLine =
    typeof structuredStartLine === 'number'
      ? structuredStartLine
      : args.success && args.data.view_range
        ? args.data.view_range[0]
        : 1;
  return <LineNumberViewer lines={lines} startLineNumber={startLine} language={language} />;
}

const LineNumberViewer = memo(function LineNumberViewer({
  lines,
  startLineNumber,
  language,
}: {
  lines: string[];
  startLineNumber: number;
  language: string;
}) {
  const theme = useStore(themeStore);
  const normalizedLanguage = normalizeCodeLanguage(language);
  const codeTheme: CodeTheme = theme === 'dark' ? 'github-dark' : 'github-light';
  const highlightedLines = useHighlightedCode(lines.join('\n'), normalizedLanguage, codeTheme)?.tokens;

  return (
    <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
      <div className="max-h-[400px] overflow-auto">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, index) => (
              <tr key={index} className="group">
                <td className="text-content-tertiary w-12 select-none border-r bg-bolt-elements-background-depth-1 px-4 py-1 text-right">
                  {index + startLineNumber}
                </td>
                <td className="whitespace-pre py-1 group-hover:bg-bolt-elements-background-depth-2">
                  {highlightedLines ? (
                    highlightedLines[index]?.map((token, tokenIndex) => (
                      <span key={tokenIndex} style={highlightTokenStyle(token)}>
                        {token.content || ' '}
                      </span>
                    ))
                  ) : (
                    <span>{line || ' '}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

function EditTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'edit' || invocation.state === 'partial-call') {
    return null;
  }
  const args = loggingSafeParse(editToolInputParameters, invocation.args);
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

function LookupDocsTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'lookupDocs' || isToolInvocationInProgress(invocation)) {
    return null;
  }
  const resultText =
    structuredContent(invocation.result) ?? (typeof invocation.result === 'string' ? invocation.result : '');
  if (resultText.startsWith('Error:')) {
    return (
      <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
        <pre>{resultText}</pre>
      </div>
    );
  }
  return (
    <ResultFrame>
      <Markdown html>{resultText}</Markdown>
    </ResultFrame>
  );
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
