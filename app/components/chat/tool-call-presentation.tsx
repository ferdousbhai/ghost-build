import type { ReactNode } from 'react';
import { CheckIcon, CircleIcon, Cross2Icon, FileIcon, Pencil1Icon } from '@radix-ui/react-icons';
import { FolderIcon } from '@heroicons/react/24/outline';
import type { ZodError } from 'zod';
import { Spinner } from '@ui/Spinner';
import type { ActionState } from '~/lib/runtime/action-runner';
import { classNames } from '~/utils/classNames';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { deployToolParameters } from 'ghostbuild-agent/tools/deploy';
import { editToolParameters } from 'ghostbuild-agent/tools/edit';
import { lookupDocsParameters } from 'ghostbuild-agent/tools/lookupDocs';
import { npmInstallToolParameters } from 'ghostbuild-agent/tools/npmInstall';
import { viewParameters } from 'ghostbuild-agent/tools/view';
import { writeFileParameters } from 'ghostbuild-agent/tools/writeFile';
import { getRelativePath } from 'ghostbuild-agent/utils/workDir';
import { loggingSafeParse } from 'ghostbuild-agent/utils/zodUtil';

const GUEST_PROJECT_CHECK_COMPLETE = 'Ghostbuild project check complete.';
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

  const resultText = typeof invocation.result === 'string' ? invocation.result : '';
  if (invocation.state !== 'result' || resultText.startsWith('Error:')) {
    return invocation;
  }
  const error = toolArgumentError(invocation);
  if (error) {
    const errorMessage = `Error: Could not parse arguments: ${error.message}`;
    return { ...invocation, result: errorMessage };
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
  const resultText = typeof invocation.result === 'string' ? invocation.result : '';
  switch (invocation.toolName) {
    case 'view':
      return viewTitle(invocation, resultText);
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
    default:
      return invocation.toolName;
  }
}

function toolArgumentError(invocation: GhostbuildToolInvocation): ZodError | null {
  switch (invocation.toolName) {
    case 'deploy': {
      const result = loggingSafeParse(deployToolParameters, invocation.args);
      return result.success ? null : result.error;
    }
    case 'edit': {
      const result = loggingSafeParse(editToolParameters, invocation.args);
      return result.success ? null : result.error;
    }
    case 'npmInstall': {
      const result = loggingSafeParse(npmInstallToolParameters, invocation.args);
      return result.success ? null : result.error;
    }
    case 'view': {
      const result = loggingSafeParse(viewParameters, invocation.args);
      return result.success ? null : result.error;
    }
    case 'writeFile': {
      const result = loggingSafeParse(writeFileParameters, invocation.args);
      return result.success ? null : result.error;
    }
    case 'lookupDocs': {
      const result = loggingSafeParse(lookupDocsParameters, invocation.args);
      return result.success ? null : result.error;
    }
    default:
      return null;
  }
}

function icon(content: ReactNode, color: string): ReactNode {
  return <div className={classNames('text-lg', color)}>{content}</div>;
}

function isErrorResult(invocation: GhostbuildToolInvocation): boolean {
  return (
    invocation.state === 'result' && typeof invocation.result === 'string' && invocation.result.startsWith('Error:')
  );
}

function titleRow(children: ReactNode, iconContent?: ReactNode): ReactNode {
  return (
    <div className="flex items-center gap-2">
      {iconContent}
      <span>{children}</span>
    </div>
  );
}

function viewTitle(invocation: GhostbuildToolInvocation, resultText: string): ReactNode {
  const args = loggingSafeParse(viewParameters, invocation.args);
  const isDirectory = invocation.state === 'result' && resultText.startsWith('Directory:');
  const renderedPath = args.success
    ? getRelativePath(args.data.path) || '/home/project'
    : isDirectory
      ? 'a directory'
      : 'a file';
  const range = args.success ? args.data.view_range : undefined;
  const extra = range ? ` (lines ${range[0]} - ${range[1] === -1 ? 'end' : range[1]})` : '';
  return titleRow(
    `${isDirectory ? 'List' : 'Read'} ${renderedPath}${extra}`,
    <div className="text-content-secondary">{isDirectory ? <FolderIcon className="size-4" /> : <FileIcon />}</div>,
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
    <span className="font-mono text-sm">{`pnpm add ${args.data.packages}`}</span>
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
  if (resultText.startsWith('Error:')) {
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
  return resultText.includes(GUEST_PROJECT_CHECK_COMPLETE)
    ? titleRow('Project ready for preview', ghostbuildIcon)
    : resultText.includes('Deployment plan ready for your approval')
      ? titleRow('Deployment ready for approval', ghostbuildIcon)
      : titleRow('Deployed Cloudflare Worker', ghostbuildIcon);
}

function editTitle(invocation: GhostbuildToolInvocation): ReactNode {
  const args = loggingSafeParse(editToolParameters, invocation.args);
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
