import { useStore } from '@nanostores/react';
import { AnimatePresence, motion } from 'framer-motion';
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  CaretUpIcon,
  CaretDownIcon,
  Cross2Icon,
  CircleIcon,
  CheckIcon,
  FileIcon,
  Pencil1Icon,
} from '@radix-ui/react-icons';
import type { ActionState } from '~/lib/runtime/action-runner';
import { workbenchStore, type ArtifactState } from '~/lib/stores/workbench.client';
import { type PartId } from '~/lib/stores/artifacts';
import { cubicEasingFn } from '~/utils/easings';
import { classNames } from '~/utils/classNames';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { viewParameters } from 'ghostbuild-agent/tools/view';
import { themeStore } from '~/lib/stores/theme';
import { path } from 'ghostbuild-agent/utils/path';
import { editToolParameters } from 'ghostbuild-agent/tools/edit';
import { writeFileParameters } from 'ghostbuild-agent/tools/writeFile';
import { npmInstallToolParameters } from 'ghostbuild-agent/tools/npmInstall';
import { loggingSafeParse } from 'ghostbuild-agent/utils/zodUtil';
import { deployToolParameters } from 'ghostbuild-agent/tools/deploy';
import type { ZodError } from 'zod';
import { Spinner } from '@ui/Spinner';
import { FolderIcon } from '@heroicons/react/24/outline';
import { getRelativePath } from 'ghostbuild-agent/utils/workDir';
import { lookupDocsParameters } from 'ghostbuild-agent/tools/lookupDocs';
import { Markdown } from '~/components/chat/Markdown';
import { getCodeHighlighter, normalizeCodeLanguage } from '~/lib/shiki.client';

const ToolOutputTerminal = lazy(() =>
  import('./ToolOutputTerminal').then((module) => ({ default: module.ToolOutputTerminal })),
);
const GHOSTBUILD_PREVIEW_VALIDATION_COMPLETE = 'Ghostbuild preview validation complete.';
const ghostbuildIcon = (
  <span aria-hidden className="mr-1 text-base leading-none">
    👻
  </span>
);

export const ToolCall = memo(function ToolCall({ partId, toolCallId }: { partId: PartId; toolCallId: string }) {
  const userToggledAction = useRef(false);
  const [showAction, setShowAction] = useState(false);

  const artifacts = useStore(workbenchStore.artifacts);
  const artifact = artifacts[partId];

  const actions = useStore(artifact.runner.actions);
  const action = actions[toolCallId];

  const toggleAction = () => {
    userToggledAction.current = true;
    setShowAction(!showAction);
  };

  const parsed: GhostbuildToolInvocation = useMemo(() => {
    return parseToolInvocation(action?.content, action?.status, artifact, toolCallId);
  }, [action?.content, action?.status, artifact, toolCallId]);

  const title = action && toolTitle(parsed);
  const icon = action && statusIcon(action.status, parsed);

  // Early return if artifact doesn't exist
  if (!artifact) {
    return null;
  }

  if (!action) {
    return null;
  }
  return (
    <div className="artifact flex w-full flex-col overflow-hidden rounded-lg border duration-150">
      <div className="flex">
        <button
          className="flex w-full items-stretch overflow-hidden bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover"
          onClick={() => {
            const showWorkbench = workbenchStore.showWorkbench.get();
            workbenchStore.showWorkbench.set(!showWorkbench);
          }}
        >
          <div className="w-full p-3.5 px-5 text-left">
            <div className="flex items-center gap-1.5">
              <div className="text-content-primary w-full text-sm font-medium leading-5">{title}</div>
              {icon}
            </div>
          </div>
        </button>
        <div className="w-px bg-bolt-elements-artifacts-borderColor" />
        <AnimatePresence>
          {artifact.type !== 'bundled' && (
            <motion.button
              initial={{ width: 0 }}
              animate={{ width: 'auto' }}
              exit={{ width: 0 }}
              transition={{ duration: 0.15, ease: cubicEasingFn }}
              className="bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover"
              disabled={parsed.state === 'partial-call'}
              onClick={toggleAction}
            >
              <div className="text-content-primary p-4">{showAction ? <CaretUpIcon /> : <CaretDownIcon />}</div>
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {showAction && (
          <motion.div
            className="actions"
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: '0px' }}
            transition={{ duration: 0.15 }}
          >
            <div className="h-px bg-bolt-elements-artifacts-borderColor" />
            <div className="bg-bolt-elements-actions-background p-5 text-left">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <ul className="list-none space-y-2.5">
                  <ToolUseContents artifact={artifact} invocation={parsed} />
                </ul>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

const ToolUseContents = memo(function ToolUseContents({
  artifact,
  invocation,
}: {
  artifact: ArtifactState;
  invocation: GhostbuildToolInvocation;
}) {
  switch (invocation.toolName) {
    case 'deploy': {
      return <DeployTool artifact={artifact} invocation={invocation} />;
    }
    case 'view': {
      return <ViewTool invocation={invocation} />;
    }
    case 'npmInstall': {
      return <NpmInstallTool artifact={artifact} invocation={invocation} />;
    }
    case 'edit': {
      return <EditTool invocation={invocation} />;
    }
    case 'writeFile': {
      return <WriteFileTool invocation={invocation} />;
    }
    case 'lookupDocs': {
      return <LookupDocsTool invocation={invocation} />;
    }
    default: {
      // Fallback for other tool types
      return <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(invocation, null, 2)}</pre>;
    }
  }
});

function DeployTool({ artifact, invocation }: { artifact: ArtifactState; invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'deploy') {
    throw new Error('Terminal can only be used for the deploy tool');
  }

  if (invocation.state === 'call' || invocation.state === 'result') {
    return (
      <Suspense fallback={null}>
        <ToolOutputTerminal artifact={artifact} invocation={invocation} />
      </Suspense>
    );
  }

  return null;
}

function NpmInstallTool({ artifact, invocation }: { artifact: ArtifactState; invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'npmInstall') {
    throw new Error('Terminal can only be used for the npmInstall tool');
  }

  const resultText = typeof invocation.result === 'string' ? invocation.result : '';
  if (invocation.state === 'call' || (invocation.state === 'result' && resultText.startsWith('Error:'))) {
    return (
      <Suspense fallback={null}>
        <ToolOutputTerminal artifact={artifact} invocation={invocation} />
      </Suspense>
    );
  }

  return null;
}

function parseToolInvocation(
  content: string | undefined,
  status: ActionState['status'] | undefined,
  artifact: ArtifactState,
  toolCallId: string,
): GhostbuildToolInvocation {
  if (!content) {
    return {} as GhostbuildToolInvocation;
  }
  let parsedContent: GhostbuildToolInvocation;
  try {
    parsedContent = JSON.parse(content);
  } catch {
    return {} as GhostbuildToolInvocation;
  }
  const resultText = typeof parsedContent.result === 'string' ? parsedContent.result : '';
  if (status === 'complete' && parsedContent.state === 'result' && !resultText.startsWith('Error:')) {
    let zodError: ZodError | null = null;
    switch (parsedContent.toolName) {
      case 'deploy': {
        const args = loggingSafeParse(deployToolParameters, parsedContent.args);
        if (!args.success) {
          zodError = args.error;
        }
        break;
      }
      case 'edit': {
        const args = loggingSafeParse(editToolParameters, parsedContent.args);
        if (!args.success) {
          zodError = args.error;
        }
        break;
      }
      case 'npmInstall': {
        const args = loggingSafeParse(npmInstallToolParameters, parsedContent.args);
        if (!args.success) {
          zodError = args.error;
        }
        break;
      }
      case 'view': {
        const args = loggingSafeParse(viewParameters, parsedContent.args);
        if (!args.success) {
          zodError = args.error;
        }
        break;
      }
      default: {
        break;
      }
    }
    if (zodError) {
      // Update the action status to failed if the args don't parse.
      if (artifact && artifact.runner) {
        const errorMessage = `Error: Could not parse arguments: ${zodError.message}`;
        artifact.runner.updateAction(toolCallId, {
          status: 'failed',
          error: errorMessage,
        });
        // Modify the result to indicate an error
        parsedContent.result = errorMessage;
      }
    }
  }
  return parsedContent;
}

function statusIcon(status: ActionState['status'], invocation: GhostbuildToolInvocation) {
  let inner: React.ReactNode;
  let color: string;

  if (isErrorResult(invocation)) {
    inner = <Cross2Icon />;
    color = 'text-bolt-elements-icon-error';
  } else {
    switch (status) {
      case 'running':
        inner = <Spinner />;
        color = 'text-bolt-elements-loader-progress';
        break;
      case 'pending':
        inner = <CircleIcon />;
        color = 'text-content-tertiary';
        break;
      case 'complete':
        inner = <CheckIcon />;
        color = 'text-bolt-elements-icon-success';
        break;
      case 'failed':
        inner = <Cross2Icon />;
        color = 'text-bolt-elements-icon-error';
        break;
      case 'aborted':
        inner = <Cross2Icon />;
        color = 'text-content-secondary';
        break;
      default:
        return null;
    }
  }
  return <div className={classNames('text-lg', color)}>{inner}</div>;
}

function isErrorResult(invocation: GhostbuildToolInvocation) {
  return (
    invocation.state === 'result' && typeof invocation.result === 'string' && invocation.result.startsWith('Error:')
  );
}

function titleRow(children: React.ReactNode, icon?: React.ReactNode) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span>{children}</span>
    </div>
  );
}

function deployFailureTitle(resultText: string) {
  if (/typecheck|tsc|verify:stack|generate-routes|cf-typegen/i.test(resultText)) {
    return titleRow(
      'App verification failed',
      <img className="mr-1 size-4" height="16" width="16" src="/icons/TypeScript.svg" alt="TypeScript" />,
    );
  }

  return titleRow('Cloudflare deploy failed');
}

function viewTitle(invocation: GhostbuildToolInvocation, resultText: string) {
  const args = loggingSafeParse(viewParameters, invocation.args);
  const isDirectory = invocation.state === 'result' && resultText.startsWith('Directory:');
  const renderedPath = args.success
    ? getRelativePath(args.data.path) || '/home/project'
    : isDirectory
      ? 'a directory'
      : 'a file';
  const range = args.success ? args.data.view_range : undefined;
  const extra = range ? ` (lines ${range[0]} - ${range[1] === -1 ? 'end' : range[1].toString()})` : '';

  return titleRow(
    `${isDirectory ? 'List' : 'Read'} ${renderedPath}${extra}`,
    <div className="text-content-secondary">{isDirectory ? <FolderIcon className="size-4" /> : <FileIcon />}</div>,
  );
}

function editTitle(invocation: GhostbuildToolInvocation) {
  const args = loggingSafeParse(editToolParameters, invocation.args);
  return titleRow(
    `Edited ${args.success ? getRelativePath(args.data.path) || args.data.path : 'a file'}`,
    <Pencil1Icon className="text-content-secondary" />,
  );
}

function writeFileTitle(invocation: GhostbuildToolInvocation) {
  if (isToolInvocationInProgress(invocation)) {
    return titleRow('Writing a file...', <FileIcon className="text-content-secondary" />);
  }

  const args = writeFileParameters.safeParse(invocation.args);
  return titleRow(
    `Wrote ${args.success ? getRelativePath(args.data.path) || args.data.path : 'a file'}`,
    <FileIcon className="text-content-secondary" />,
  );
}

function toolTitle(invocation: GhostbuildToolInvocation): React.ReactNode {
  const resultText = typeof invocation.result === 'string' ? invocation.result : '';

  switch (invocation.toolName) {
    case 'view': {
      return viewTitle(invocation, resultText);
    }
    case 'npmInstall': {
      if (isToolInvocationInProgress(invocation)) {
        return `Installing dependencies...`;
      }

      if (isErrorResult(invocation)) {
        return `Failed to install dependencies`;
      }

      const args = loggingSafeParse(npmInstallToolParameters, invocation.args);
      return args.success ? (
        <span className="font-mono text-sm">{`pnpm add ${args.data.packages}`}</span>
      ) : (
        `Failed to install dependencies`
      );
    }
    case 'deploy': {
      if (isToolInvocationInProgress(invocation)) {
        return titleRow(
          'Checking the app...',
          <img className="mr-1 size-4" height="16" width="16" src="/icons/TypeScript.svg" alt="TypeScript" />,
        );
      }

      if (resultText.startsWith('Error:')) {
        return deployFailureTitle(resultText);
      }

      if (resultText.includes(GHOSTBUILD_PREVIEW_VALIDATION_COMPLETE)) {
        return titleRow('App validated for preview', ghostbuildIcon);
      }

      return titleRow('Deployed Cloudflare Worker', ghostbuildIcon);
    }
    case 'edit': {
      return editTitle(invocation);
    }
    case 'writeFile': {
      return writeFileTitle(invocation);
    }
    case 'lookupDocs': {
      const args = loggingSafeParse(lookupDocsParameters, invocation.args);
      if (!args.success) {
        return 'Looking up documentation...';
      }
      return (
        <div className="flex items-center gap-2">
          <FileIcon className="text-content-secondary" />
          <span>Looked up documentation for: {args.data.docs.join(', ')}</span>
        </div>
      );
    }
    default: {
      return invocation.toolName;
    }
  }
}

function ViewTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'view') {
    throw new Error('View tool can only be used for the view tool');
  }
  if (isToolInvocationInProgress(invocation)) {
    return null;
  }
  const resultText = typeof invocation.result === 'string' ? invocation.result : '';
  if (resultText.startsWith('Error:')) {
    return (
      <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
        <pre>{resultText}</pre>
      </div>
    );
  }

  // Directory listing
  if (resultText.startsWith('Directory:')) {
    const items = resultText.split('\n').slice(1);
    return (
      <div className="text-content-primary space-y-1 rounded-lg border p-4 font-mono text-sm">
        {items.map((item: string, i: number) => {
          const isDir = item.includes('(dir)');
          const trimmed = item.replace('(dir)', '').replace('(file)', '').replace('- ', '').trim();
          return (
            <div key={i} className="flex items-center gap-2">
              {isDir ? <FolderIcon className="size-4" /> : <FileIcon />}
              {trimmed}
            </div>
          );
        })}
      </div>
    );
  }

  // File contents with line numbers
  const lines = resultText.split('\n').map((line: string) => {
    const [_, ...content] = line.split(':');
    return content.join(':');
  });
  const args = loggingSafeParse(viewParameters, invocation.args);
  let startLine = 1;
  let language = 'typescript';
  if (args.success) {
    language = normalizeCodeLanguage(path.extname(args.data.path));
    if (args.data.view_range) {
      startLine = args.data.view_range[0];
    }
  }
  return <LineNumberViewer lines={lines} startLineNumber={startLine} language={language} />;
}

interface LineNumberViewerProps {
  lines: string[];
  startLineNumber?: number;
  language?: string;
}

const LineNumberViewer = memo(function LineNumberViewer({
  lines,
  startLineNumber = 1,
  language = 'typescript',
}: LineNumberViewerProps) {
  const [highlighter, setHighlighter] = useState<Awaited<ReturnType<typeof getCodeHighlighter>> | null>(null);
  const theme = useStore(themeStore);
  const normalizedLanguage = normalizeCodeLanguage(language);

  useEffect(() => {
    let active = true;

    getCodeHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: normalizedLanguage === 'plaintext' || normalizedLanguage === 'text' ? [] : [normalizedLanguage],
    }).then((loadedHighlighter) => {
      if (active) {
        setHighlighter(loadedHighlighter);
      }
    });

    return () => {
      active = false;
    };
  }, [normalizedLanguage]);

  return (
    <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
      <div className="max-h-[400px] overflow-auto">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line: string, i: number) => (
              <tr key={i} className="group">
                <td className="text-content-tertiary w-12 select-none border-r bg-bolt-elements-background-depth-1 px-4 py-1 text-right">
                  {i + startLineNumber}
                </td>
                <td className="whitespace-pre py-1 group-hover:bg-bolt-elements-background-depth-2">
                  <span
                    dangerouslySetInnerHTML={{
                      __html: highlighter
                        ? highlighter
                            .codeToHtml(line || ' ', {
                              lang: normalizedLanguage,
                              theme: theme === 'dark' ? 'github-dark' : 'github-light',
                            })
                            .replace(/<\/?pre[^>]*>/g, '')
                            .replace(/<\/?code[^>]*>/g, '')
                        : line || ' ',
                    }}
                  />
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
  if (invocation.toolName !== 'edit') {
    throw new Error('Edit tool can only be used for the edit tool');
  }
  if (invocation.state === 'partial-call') {
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
          <div className="flex items-center gap-2">
            <pre className="text-bolt-elements-icon-error">{args.data.old}</pre>
          </div>
          <div className="flex items-center gap-2">
            <pre className="text-bolt-elements-icon-success">{args.data.new}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function WriteFileTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'writeFile') {
    throw new Error('WriteFile tool can only be used for the writeFile tool');
  }
  if (invocation.state === 'partial-call') {
    return null;
  }
  const args = loggingSafeParse(writeFileParameters, invocation.args);
  if (!args.success) {
    return null;
  }
  return (
    <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
      <div className="max-h-[400px] overflow-auto p-4">
        <pre>{args.data.content}</pre>
      </div>
    </div>
  );
}

function LookupDocsTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'lookupDocs') {
    throw new Error('LookupDocs tool can only be used for the lookupDocs tool');
  }
  if (isToolInvocationInProgress(invocation)) {
    return null;
  }
  const resultText = typeof invocation.result === 'string' ? invocation.result : '';
  if (resultText.startsWith('Error:')) {
    return (
      <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
        <pre>{resultText}</pre>
      </div>
    );
  }

  return (
    <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
      <div className="max-h-[400px] overflow-auto p-4">
        <Markdown html>{resultText}</Markdown>
      </div>
    </div>
  );
}
