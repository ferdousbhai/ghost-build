import { memo, useEffect } from 'react';
import { z } from 'zod';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { isGhostbuildToolResult, toolResultSucceeded, toolResultSummary } from 'ghostbuild-agent/tool-result';
import { ToolResultFrame } from './ToolResultFrame';
import { captureProductEvent } from '~/lib/telemetry.client';

export const ToolUseContents = memo(function ToolUseContents({
  invocation,
  progress,
}: {
  invocation: GhostbuildToolInvocation;
  progress?: unknown;
}) {
  if (isToolInvocationInProgress(invocation)) {
    return <RunningToolContents invocation={invocation} progress={progress} />;
  }
  return invocation.toolName === 'read' ||
    invocation.toolName === 'write' ||
    invocation.toolName === 'edit' ||
    invocation.toolName === 'exec' ? (
    <StructuredResultTool invocation={invocation} />
  ) : (
    <pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(invocation, null, 2)}</pre>
  );
});

function RunningToolContents({ invocation, progress }: { invocation: GhostbuildToolInvocation; progress?: unknown }) {
  const input = runningToolInputSchema.safeParse(invocation.input).data;
  const progressRecord = runningToolProgressSchema.safeParse(progress).data;
  const details = runningToolProgressSchema.safeParse(progressRecord?.details).data ?? progressRecord;
  const path = input?.path;
  let preview = '';

  if (invocation.toolName === 'exec') {
    const command = input?.command ?? '';
    const stdout = details?.stdout ?? '';
    const stderr = details?.stderr ?? '';
    preview = [`$ ${command || '…'}`, stdout, stderr].filter(Boolean).join('\n');
  } else if (invocation.toolName === 'write') {
    const content = input?.content ?? '';
    preview = content ? tailLines(content, 12) : path ? `Preparing ${path}` : 'Preparing file content…';
  } else if (invocation.toolName === 'edit') {
    const edits = input?.edits ?? [];
    preview =
      edits.length > 0 ? JSON.stringify(edits, null, 2) : path ? `Preparing edits for ${path}` : 'Preparing edits…';
  } else if (invocation.toolName === 'read') {
    preview = path ? `Reading ${path}` : 'Resolving file path…';
  } else {
    preview = 'Working…';
  }

  return (
    <ToolResultFrame>
      <pre
        aria-live="polite"
        className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-5 text-content-secondary"
      >
        {preview}
      </pre>
    </ToolResultFrame>
  );
}

function tailLines(value: string, limit: number): string {
  const lines = value.split('\n');
  const visible = lines.slice(-limit).join('\n');
  return lines.length > limit ? `… ${lines.length - limit} earlier lines\n${visible}` : visible;
}

/**
 * A streaming tool call carries partially-formed arguments and progress, so every field is read
 * best-effort: a field with the wrong shape falls back to absent rather than discarding the rest.
 */
const optionalText = z.string().optional().catch(undefined);

const runningToolInputSchema = z.looseObject({
  path: optionalText,
  command: optionalText,
  content: optionalText,
  edits: z.array(z.unknown()).optional().catch(undefined),
});

const runningToolProgressSchema = z.looseObject({
  stdout: optionalText,
  stderr: optionalText,
  details: z.unknown().optional(),
});

const validationOutputSchema = z.looseObject({ validation: z.unknown().optional() });

function StructuredResultTool({ invocation }: { invocation: GhostbuildToolInvocation }) {
  const complete = !isToolInvocationInProgress(invocation);
  const succeeded = invocation.state === 'output-available' && toolResultSucceeded(invocation.output);
  const validation =
    invocation.state === 'output-available'
      ? validationOutputSchema.safeParse(invocation.output).data?.validation
      : undefined;
  const validationSucceeded = isGhostbuildToolResult(validation) && validation.ok;
  useEffect(() => {
    if (!complete) {
      return;
    }
    // Every completed tool card reaches this effect, so the once-per-journey claim
    // inside `captureProductEvent` is what keeps this a single funnel event.
    void captureProductEvent('first_tool_completed', {
      outcome: succeeded ? 'success' : invocation.state === 'output-denied' ? 'cancelled' : 'failure',
    });
    if (validationSucceeded) {
      void captureProductEvent('validation_succeeded', { outcome: 'success' });
    }
  }, [complete, invocation.state, invocation.toolCallId, succeeded, validationSucceeded]);

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
