import type { ReactNode } from 'react';
import { CheckIcon, CircleIcon, Cross2Icon, FileIcon, Pencil1Icon } from '@radix-ui/react-icons';
import { FolderIcon } from '@heroicons/react/24/outline';
import type { ZodError, ZodType } from 'zod';
import { Spinner } from '@ui/Spinner';
import type { ToolActivityStatus } from '~/lib/common/types';
import { classNames } from '~/utils/classNames';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { deployToolInputParameters } from 'ghostbuild-agent/tools/deploy';
import { lookupDocsParameters } from 'ghostbuild-agent/tools/lookupDocs';
import { npmInstallToolParameters } from 'ghostbuild-agent/tools/npmInstall';
import { getRelativePath } from 'ghostbuild-agent/utils/workDir';
import { loggingSafeParse } from 'ghostbuild-agent/utils/zodUtil';
import { validateProjectParameters } from 'ghostbuild-agent/tools/validateProject';
import type { GhostbuildToolName } from 'ghostbuild-agent/types';
import { COMPUTER_TOOL_INPUT_SCHEMAS } from 'ghostbuild-agent/cloudflare-computer-inputs';
import {
  isGhostbuildToolResult,
  toolFailure,
  toolResultSucceeded,
  toolResultSummary,
} from 'ghostbuild-agent/tool-result';

const {
  edit: editSchema,
  exec: execSchema,
  ls: pathSchema,
  read: readSchema,
  write: writeSchema,
} = COMPUTER_TOOL_INPUT_SCHEMAS;

const ghostbuildIcon = (
  <span aria-hidden className="mr-1 text-base leading-none">
    👻
  </span>
);

const validationIcon = <FileIcon className="mr-1 size-4 text-content-secondary" />;

const emptyInvocation: GhostbuildToolInvocation = {
  state: 'partial-call',
  toolCallId: '',
  toolName: '',
  args: {},
};

const TOOL_INPUT_SCHEMAS: Record<GhostbuildToolName, ZodType> = {
  deploy: deployToolInputParameters,
  ...COMPUTER_TOOL_INPUT_SCHEMAS,
  lookupDocs: lookupDocsParameters,
  npmInstall: npmInstallToolParameters,
  validateProject: validateProjectParameters,
};

export function normalizeToolInvocation(invocation: GhostbuildToolInvocation | undefined): GhostbuildToolInvocation {
  if (!invocation) {
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

export function statusIcon(status: ToolActivityStatus, invocation: GhostbuildToolInvocation): ReactNode {
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
    case 'aborted':
      return icon(<Cross2Icon />, 'text-content-secondary');
    default:
      return null;
  }
}

export function toolTitle(invocation: GhostbuildToolInvocation): ReactNode {
  const resultText = toolResultSummary(invocation.result);
  switch (invocation.toolName) {
    case 'read':
      return readTitle(invocation);
    case 'npmInstall':
      return packageTitle(invocation);
    case 'deploy':
      return deployTitle(invocation, resultText);
    case 'edit':
      return editTitle(invocation);
    case 'write':
      return writeTitle(invocation);
    case 'lookupDocs': {
      const args = loggingSafeParse(lookupDocsParameters, invocation.args);
      return args.success
        ? titleRow(`Looked up documentation for: ${args.data.docs.join(', ')}`, <FileIcon />)
        : 'Looking up documentation...';
    }
    case 'ls': {
      const args = loggingSafeParse(pathSchema, invocation.args);
      return titleRow(
        `Listed ${args.success ? getRelativePath(args.data.path) || '/home/project' : 'project files'}`,
        <FolderIcon className="size-4" />,
      );
    }
    case 'exec': {
      const args = loggingSafeParse(execSchema, invocation.args);
      return titleRow(args.success ? `Ran ${args.data.command}` : 'Ran a workspace command', <FileIcon />);
    }
    case 'validateProject':
      return titleRow(
        isToolInvocationInProgress(invocation)
          ? 'Validating the project...'
          : isErrorResult(invocation)
            ? 'Project validation failed'
            : 'Project validation passed',
        validationIcon,
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

function readTitle(invocation: GhostbuildToolInvocation): ReactNode {
  const args = loggingSafeParse(readSchema, invocation.args);
  const renderedPath = args.success ? getRelativePath(args.data.path) || '/home/project' : 'a file';
  const extra = args.success && args.data.offset ? ` (from line ${args.data.offset})` : '';
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
    return titleRow('Checking the project...', validationIcon);
  }
  if (isErrorResult(invocation)) {
    if (/preview|render|vite|server rendering|smoke/i.test(resultText)) {
      return titleRow('Preview validation failed', ghostbuildIcon);
    }
    if (/typecheck|tsc|verify:stack|generate-routes|cf-typegen/i.test(resultText)) {
      return titleRow('App verification failed', validationIcon);
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
  const args = loggingSafeParse(editSchema, invocation.args);
  return titleRow(
    `Edited ${args.success ? getRelativePath(args.data.path) || args.data.path : 'a file'}`,
    <Pencil1Icon className="text-content-secondary" />,
  );
}

function writeTitle(invocation: GhostbuildToolInvocation): ReactNode {
  if (isToolInvocationInProgress(invocation)) {
    return titleRow('Writing a file...', <FileIcon className="text-content-secondary" />);
  }
  const args = writeSchema.safeParse(invocation.args);
  return titleRow(
    `Wrote ${args.success ? getRelativePath(args.data.path) || args.data.path : 'a file'}`,
    <FileIcon className="text-content-secondary" />,
  );
}
