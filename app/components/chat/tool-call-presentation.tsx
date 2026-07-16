import type { ReactNode } from 'react';
import { CheckIcon, CircleIcon, Cross2Icon, FileIcon, Pencil1Icon } from '@radix-ui/react-icons';
import { FolderIcon } from '@heroicons/react/24/outline';
import type { ZodError, ZodType } from 'zod';
import { Spinner } from '@ui/Spinner';
import type { ActionState } from '~/lib/runtime/action-runner';
import { classNames } from '~/utils/classNames';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { deployToolInputParameters } from 'ghostbuild-agent/tools/deploy';
import { editToolInputParameters } from 'ghostbuild-agent/tools/edit';
import { lookupDocsParameters } from 'ghostbuild-agent/tools/lookupDocs';
import { npmInstallToolParameters } from 'ghostbuild-agent/tools/npmInstall';
import { viewToolInputParameters } from 'ghostbuild-agent/tools/view';
import { writeFileParameters } from 'ghostbuild-agent/tools/writeFile';
import { getRelativePath } from 'ghostbuild-agent/utils/workDir';
import { loggingSafeParse } from 'ghostbuild-agent/utils/zodUtil';
import { listFilesParameters } from 'ghostbuild-agent/tools/listFiles';
import { searchTextParameters } from 'ghostbuild-agent/tools/searchText';
import { getDiagnosticsParameters } from 'ghostbuild-agent/tools/getDiagnostics';
import { validateProjectParameters } from 'ghostbuild-agent/tools/validateProject';
import type { GhostbuildToolName } from 'ghostbuild-agent/types';
import {
  isGhostbuildToolResult,
  toolFailure,
  toolResultSucceeded,
  toolResultSummary,
} from 'ghostbuild-agent/tool-result';

const ghostbuildIcon = (
  <span aria-hidden className="mr-1 text-base leading-none">
    👻
  </span>
);

const emptyInvocation: GhostbuildToolInvocation = {
  state: 'partial-call',
  toolCallId: '',
  toolName: '',
  args: {},
};

const TOOL_INPUT_SCHEMAS: Record<GhostbuildToolName, ZodType> = {
  deploy: deployToolInputParameters,
  edit: editToolInputParameters,
  getDiagnostics: getDiagnosticsParameters,
  listFiles: listFilesParameters,
  lookupDocs: lookupDocsParameters,
  npmInstall: npmInstallToolParameters,
  searchText: searchTextParameters,
  validateProject: validateProjectParameters,
  view: viewToolInputParameters,
  writeFile: writeFileParameters,
};

export function parseToolInvocation(content: string | undefined): GhostbuildToolInvocation {
  if (!content) {
    return emptyInvocation;
  }
  let invocation: GhostbuildToolInvocation;
  try {
    invocation = JSON.parse(content);
  } catch {
    return emptyInvocation;
  }

  if (invocation.state !== 'result' || isErrorResult(invocation)) {
    return invocation;
  }
  const error = toolArgumentError(invocation);
  if (error) {
    return { ...invocation, result: toolFailure(`Could not parse arguments: ${error.message}`) };
  }
  return invocation;
}

export function statusIcon(status: ActionState['status'], invocation: GhostbuildToolInvocation): ReactNode {
  if (isErrorResult(invocation)) {
    return icon(<Cross2Icon />, 'text-bolt-elements-icon-error');
  }
  switch (status) {
    case 'running':
      return icon(<Spinner />, 'text-bolt-elements-loader-progress');
    case 'pending':
      return icon(<CircleIcon />, 'text-content-tertiary');
    case 'complete':
      return icon(<CheckIcon />, 'text-bolt-elements-icon-success');
    case 'failed':
      return icon(<Cross2Icon />, 'text-bolt-elements-icon-error');
    case 'aborted':
      return icon(<Cross2Icon />, 'text-content-secondary');
    default:
      return null;
  }
}

export function toolTitle(invocation: GhostbuildToolInvocation): ReactNode {
  const resultText = toolResultSummary(invocation.result);
  switch (invocation.toolName) {
    case 'view':
      return viewTitle(invocation);
    case 'npmInstall':
      return packageTitle(invocation);
    case 'deploy':
      return deployTitle(invocation, resultText);
    case 'edit':
      return editTitle(invocation);
    case 'writeFile':
      return writeFileTitle(invocation);
    case 'lookupDocs': {
      const args = loggingSafeParse(lookupDocsParameters, invocation.args);
      return args.success
        ? titleRow(`Looked up documentation for: ${args.data.docs.join(', ')}`, <FileIcon />)
        : 'Looking up documentation...';
    }
    case 'listFiles': {
      const args = loggingSafeParse(listFilesParameters, invocation.args);
      return titleRow(
        `Listed ${args.success ? getRelativePath(args.data.path ?? '/home/project') || '/home/project' : 'project files'}`,
        <FolderIcon className="size-4" />,
      );
    }
    case 'searchText': {
      const args = loggingSafeParse(searchTextParameters, invocation.args);
      return titleRow(
        args.success ? `Searched for ${JSON.stringify(args.data.query)}` : 'Searched project text',
        <FileIcon />,
      );
    }
    case 'getDiagnostics':
      return titleRow('Read operation diagnostics', <FileIcon />);
    case 'validateProject':
      return titleRow(
        isToolInvocationInProgress(invocation)
          ? 'Validating the project...'
          : isErrorResult(invocation)
            ? 'Project validation failed'
            : 'Project validation passed',
        <img className="mr-1 size-4" height="16" width="16" src="/icons/TypeScript.svg" alt="TypeScript" />,
      );
    default:
      return invocation.toolName;
  }
}

function toolArgumentError(invocation: GhostbuildToolInvocation): ZodError | null {
  const schema = TOOL_INPUT_SCHEMAS[invocation.toolName as GhostbuildToolName];
  if (!schema) {
    return null;
  }
  const result = loggingSafeParse(schema, invocation.args);
  return result.success ? null : result.error;
}

function icon(content: ReactNode, color: string): ReactNode {
  return <div className={classNames('text-lg', color)}>{content}</div>;
}

function isErrorResult(invocation: GhostbuildToolInvocation): boolean {
  return invocation.state === 'result' && !toolResultSucceeded(invocation.result);
}

function titleRow(children: ReactNode, iconContent?: ReactNode): ReactNode {
  return (
    <div className="flex items-center gap-2">
      {iconContent}
      <span>{children}</span>
    </div>
  );
}

function viewTitle(invocation: GhostbuildToolInvocation): ReactNode {
  const args = loggingSafeParse(viewToolInputParameters, invocation.args);
  const renderedPath = args.success ? getRelativePath(args.data.path) || '/home/project' : 'a file';
  const range = args.success ? args.data.view_range : undefined;
  const extra = range ? ` (lines ${range[0]} - ${range[1] === -1 ? 'end' : range[1]})` : '';
  return titleRow(
    `Read ${renderedPath}${extra}`,
    <div className="text-content-secondary">
      <FileIcon />
    </div>,
  );
}

function packageTitle(invocation: GhostbuildToolInvocation): ReactNode {
  if (isToolInvocationInProgress(invocation)) {
    return 'Installing dependencies...';
  }
  if (isErrorResult(invocation)) {
    return 'Failed to install dependencies';
  }
  const args = loggingSafeParse(npmInstallToolParameters, invocation.args);
  return args.success ? (
    <span className="font-mono text-sm">
      {args.data.mode === 'sync-lockfile' ? 'pnpm install --lockfile-only' : `pnpm add ${args.data.packages}`}
    </span>
  ) : (
    'Failed to install dependencies'
  );
}

function deployTitle(invocation: GhostbuildToolInvocation, resultText: string): ReactNode {
  if (isToolInvocationInProgress(invocation)) {
    return titleRow(
      'Checking the project...',
      <img className="mr-1 size-4" height="16" width="16" src="/icons/TypeScript.svg" alt="TypeScript" />,
    );
  }
  if (isErrorResult(invocation)) {
    if (/preview|render|vite|server rendering|smoke/i.test(resultText)) {
      return titleRow('Preview validation failed', ghostbuildIcon);
    }
    if (/typecheck|tsc|verify:stack|generate-routes|cf-typegen/i.test(resultText)) {
      return titleRow(
        'App verification failed',
        <img className="mr-1 size-4" height="16" width="16" src="/icons/TypeScript.svg" alt="TypeScript" />,
      );
    }
    return titleRow('Cloudflare deploy failed');
  }
  const state =
    isGhostbuildToolResult(invocation.result) && typeof invocation.result.data === 'object' && invocation.result.data
      ? (invocation.result.data as { state?: unknown }).state
      : undefined;
  return state === 'awaiting-approval' || resultText.includes('Deployment plan ready for your approval')
    ? titleRow('Deployment ready for approval', ghostbuildIcon)
    : titleRow('Deployed Cloudflare Worker', ghostbuildIcon);
}

function editTitle(invocation: GhostbuildToolInvocation): ReactNode {
  const args = loggingSafeParse(editToolInputParameters, invocation.args);
  return titleRow(
    `Edited ${args.success ? getRelativePath(args.data.path) || args.data.path : 'a file'}`,
    <Pencil1Icon className="text-content-secondary" />,
  );
}

function writeFileTitle(invocation: GhostbuildToolInvocation): ReactNode {
  if (isToolInvocationInProgress(invocation)) {
    return titleRow('Writing a file...', <FileIcon className="text-content-secondary" />);
  }
  const args = writeFileParameters.safeParse(invocation.args);
  return titleRow(
    `Wrote ${args.success ? getRelativePath(args.data.path) || args.data.path : 'a file'}`,
    <FileIcon className="text-content-secondary" />,
  );
}
