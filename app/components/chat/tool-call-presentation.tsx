import type { ReactNode } from 'react';
import { CheckIcon, CircleIcon, Cross2Icon, FileIcon, Pencil1Icon } from '@radix-ui/react-icons';
import { Spinner } from '@ui/Spinner';
import type { ToolActivityStatus } from '~/lib/common/types';
import { classNames } from '~/utils/classNames';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { getRelativePath } from 'ghostbuild-agent/utils/workDir';
import { MODEL_TOOL_INPUT_SCHEMAS } from 'ghostbuild-agent/model-tool-inputs';
import type { ZodType } from 'zod';
import { toolFailure, toolResultSucceeded } from 'ghostbuild-agent/tool-result';

const MAX_TOOL_TITLE_VALUE_CHARACTERS = 160;
/** Keyed by the model-facing tool name, which arrives as an unconstrained string on the invocation. */
const STOPPED_TOOL_TITLES = new Map<string, string>([
  ['read', 'File read stopped'],
  ['write', 'File write stopped'],
  ['edit', 'File edit stopped'],
  ['exec', 'Command stopped'],
]);

const MODEL_TOOL_INPUT_SCHEMA_BY_NAME = new Map<string, ZodType>(Object.entries(MODEL_TOOL_INPUT_SCHEMAS));

const emptyInvocation: GhostbuildToolInvocation = {
  type: 'dynamic-tool',
  state: 'input-streaming',
  toolCallId: '',
  toolName: '',
  input: {},
};

export function normalizeToolInvocation(invocation: GhostbuildToolInvocation | undefined): GhostbuildToolInvocation {
  if (!invocation || invocation.state !== 'output-available' || isErrorResult(invocation)) {
    return invocation ?? emptyInvocation;
  }
  const schema = MODEL_TOOL_INPUT_SCHEMA_BY_NAME.get(invocation.toolName);
  const parsed = schema?.safeParse(invocation.input);
  return parsed?.success === false
    ? { ...invocation, output: toolFailure(`Could not parse arguments: ${parsed.error.message}`) }
    : invocation;
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
  }
  return null;
}

export function toolTitle(invocation: GhostbuildToolInvocation, status: ToolActivityStatus): ReactNode {
  if (status === 'aborted') {
    return STOPPED_TOOL_TITLES.get(invocation.toolName) ?? 'Tool stopped';
  }
  switch (invocation.toolName) {
    case 'read':
      return readTitle(invocation, status);
    case 'write':
      return writeTitle(invocation);
    case 'edit':
      return editTitle(invocation, status);
    case 'exec': {
      const args = MODEL_TOOL_INPUT_SCHEMAS.exec.safeParse(invocation.input);
      return titleRow(
        args.success
          ? `${status === 'running' ? 'Running' : 'Ran'} ${compactToolLabel(args.data.command)}`
          : status === 'running'
            ? 'Running a workspace command'
            : 'Ran a workspace command',
        <FileIcon />,
      );
    }
    default:
      return invocation.toolName;
  }
}

function icon(content: ReactNode, color: string): ReactNode {
  return <div className={classNames('text-lg', color)}>{content}</div>;
}

function isErrorResult(invocation: GhostbuildToolInvocation): boolean {
  return (
    invocation.state === 'output-error' ||
    invocation.state === 'output-denied' ||
    (invocation.state === 'output-available' && !toolResultSucceeded(invocation.output))
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

function readTitle(invocation: GhostbuildToolInvocation, status: ToolActivityStatus): ReactNode {
  const args = MODEL_TOOL_INPUT_SCHEMAS.read.safeParse(invocation.input);
  const renderedPath = args.success ? compactToolLabel(getRelativePath(args.data.path) || '/home/project') : 'a file';
  const extra = args.success && args.data.offset ? ` (from line ${args.data.offset})` : '';
  return titleRow(
    `${status === 'running' ? 'Reading' : 'Read'} ${renderedPath}${extra}`,
    <FileIcon className="text-content-secondary" />,
  );
}

function editTitle(invocation: GhostbuildToolInvocation, status: ToolActivityStatus): ReactNode {
  const args = MODEL_TOOL_INPUT_SCHEMAS.edit.safeParse(invocation.input);
  return titleRow(
    `${status === 'running' ? 'Editing' : 'Edited'} ${args.success ? compactToolLabel(getRelativePath(args.data.path) || args.data.path) : 'a file'}`,
    <Pencil1Icon className="text-content-secondary" />,
  );
}

function writeTitle(invocation: GhostbuildToolInvocation): ReactNode {
  if (isToolInvocationInProgress(invocation)) {
    return titleRow('Writing a file...', <FileIcon className="text-content-secondary" />);
  }
  const args = MODEL_TOOL_INPUT_SCHEMAS.write.safeParse(invocation.input);
  return titleRow(
    `Wrote ${args.success ? compactToolLabel(getRelativePath(args.data.path) || args.data.path) : 'a file'}`,
    <FileIcon className="text-content-secondary" />,
  );
}

export function compactToolLabel(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length <= MAX_TOOL_TITLE_VALUE_CHARACTERS
    ? singleLine
    : `${singleLine.slice(0, MAX_TOOL_TITLE_VALUE_CHARACTERS - 1)}…`;
}
