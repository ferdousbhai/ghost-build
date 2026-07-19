import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { validateProjectParameters } from 'ghostbuild-agent/tools/validateProject';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';
import { getAuthToken } from '~/lib/stores/sessionId';
import { streamOutput } from '~/utils/process';
import { createPreviewSmokeCheckScript } from './preview-smoke-check';
import { runCommand } from './command';
import type { ActionRunnerWorkspace } from './types';
import { deploymentSnapshotRevision, exportDeploymentSnapshot } from './revision';
import { ActionCommandExecutionError, ActionCommandTimeoutError } from './errors';
import { parseOperationDiagnostics, type DiagnosticsStore, type OperationDiagnostic } from './diagnostics-store';
import { pageCoverage } from './bounded-pagination';
import type { DeploymentValidationStore } from './deployment-validation-store';

type ValidationCheckName = 'typecheck' | 'lint' | 'build' | 'preview' | 'workspace-stability';
type ValidationCheck = {
  name: ValidationCheckName;
  status: 'passed' | 'failed' | 'not-run';
  durationMs: number;
  diagnosticCount?: number;
  reason?: string;
};

type ValidationCheckResult = { check: ValidationCheck; diagnostics: OperationDiagnostic[] };

type CommandValidationCheckName = Exclude<ValidationCheckName, 'preview' | 'workspace-stability'>;

const VALIDATION_COMMANDS: Record<CommandValidationCheckName, string[]> = {
  typecheck: ['pnpm', 'run', 'typecheck'],
  lint: ['pnpm', 'run', 'lint'],
  build: ['pnpm', 'run', 'build'],
};

export async function runValidateProject(args: {
  invocation: GhostbuildToolInvocation;
  container: WebContainer;
  abortSignal: AbortSignal;
  onOutput: (output: string) => void;
  workspace: ActionRunnerWorkspace;
  diagnostics: DiagnosticsStore;
  deploymentValidation: DeploymentValidationStore;
}) {
  const input = validateProjectParameters.parse(args.invocation.args);
  if (input.level === 'full') {
    args.deploymentValidation.beginFullValidation();
  }
  await waitForContainerBootState(ContainerBootState.READY);
  args.abortSignal.throwIfAborted();
  const startingRevision = await captureDeploymentRevision(args.container, args.abortSignal);

  const checks: ValidationCheck[] = [];
  const diagnostics: OperationDiagnostic[] = [];
  for (const name of input.level === 'full'
    ? (['typecheck', 'lint', 'build'] as const)
    : (['typecheck', 'lint'] as const)) {
    const result = await runValidationCommand(name, args);
    checks.push(result.check);
    diagnostics.push(...result.diagnostics);
  }

  if (input.level === 'full') {
    if (checks.some((check) => check.status === 'failed')) {
      checks.push({
        name: 'preview',
        status: 'not-run',
        durationMs: 0,
        reason: 'Preview smoke check was skipped because an earlier validation check failed.',
      });
    } else {
      const result = await runPreviewCheck(args);
      checks.push(result.check);
      diagnostics.push(...result.diagnostics);
    }
  }

  const revision = await captureDeploymentRevision(args.container, args.abortSignal);
  if (revision !== startingRevision) {
    checks.push({
      name: 'workspace-stability',
      status: 'failed',
      durationMs: 0,
      reason: 'The workspace changed while validation was running. Validate the new revision again.',
      diagnosticCount: 1,
    });
    diagnostics.push({
      operation: 'validation',
      check: 'workspace-stability',
      severity: 'error',
      message: 'The workspace changed while validation was running. Validate the new revision again.',
    });
  }
  const failed = checks.filter((check) => check.status === 'failed');
  const data = {
    level: input.level,
    revision,
    ...(revision !== startingRevision ? { startingRevision } : {}),
    checks,
  };
  if (failed.length > 0) {
    const { page, diagnosticsId } = args.diagnostics.start('project validation diagnostics', diagnostics);
    const nextCursor = page.complete ? undefined : String(page.end);
    return toolFailure(
      `Project validation failed at workspace revision ${revision}: ${failed.map((check) => check.name).join(', ')}.${nextCursor ? ' Continue the structured diagnostics with getDiagnostics.' : ''}`,
      { ...data, diagnostics: page.items, ...(diagnosticsId ? { diagnosticsId } : {}) },
      pageCoverage(page, nextCursor),
    );
  }
  const sessionId = getAuthToken();
  if (input.level === 'full') {
    args.deploymentValidation.recordFullValidation(revision);
  }
  const nextAction = !sessionId ? 'sign-in-required' : 'prepare-deployment';
  return toolSuccess(
    `Project validation passed at workspace revision ${revision}: ${checks.map((check) => check.name).join(', ')}.`,
    { ...data, nextAction },
  );
}

async function captureDeploymentRevision(container: WebContainer, abortSignal: AbortSignal): Promise<string> {
  abortSignal.throwIfAborted();
  const snapshot = await exportDeploymentSnapshot(container);
  abortSignal.throwIfAborted();
  return deploymentSnapshotRevision(snapshot);
}

async function runValidationCommand(
  name: CommandValidationCheckName,
  args: Parameters<typeof runValidateProject>[0],
): Promise<ValidationCheckResult> {
  const startedAt = performance.now();
  try {
    await runCommand({
      container: args.container,
      command: VALIDATION_COMMANDS[name],
      displayName: VALIDATION_COMMANDS[name].join(' '),
      abortSignal: args.abortSignal,
      onOutput: args.onOutput,
      timeoutMs: name === 'build' ? 180_000 : 120_000,
    });
    return {
      check: { name, status: 'passed', durationMs: Math.round(performance.now() - startedAt) },
      diagnostics: [],
    };
  } catch (error) {
    args.abortSignal.throwIfAborted();
    const diagnostics = parseOperationDiagnostics(commandDiagnosticText(error), {
      operation: 'validation',
      check: name,
    });
    return {
      check: {
        name,
        status: 'failed',
        durationMs: Math.round(performance.now() - startedAt),
        reason: `${VALIDATION_COMMANDS[name].join(' ')} failed.`,
        diagnosticCount: diagnostics.length,
      },
      diagnostics,
    };
  }
}

async function runPreviewCheck(args: Parameters<typeof runValidateProject>[0]): Promise<ValidationCheckResult> {
  const startedAt = performance.now();
  let previewProcess: WebContainerProcess | undefined;
  let previewOutputPromise: Promise<{ output: string; exitCode: number }> | undefined;
  let port = args.workspace.getPreviewPort();
  try {
    if (!port) {
      port = 4174;
      previewProcess = await args.container.spawn('pnpm', [
        'run',
        'dev',
        '--',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ]);
      previewOutputPromise = streamOutput(previewProcess, { onOutput: args.onOutput, debounceMs: 50 });
    }
    await runCommand({
      container: args.container,
      command: ['node', '--input-type=module', '--eval', createPreviewSmokeCheckScript(port, 30_000)],
      displayName: `preview smoke check on port ${port}`,
      abortSignal: args.abortSignal,
      onOutput: args.onOutput,
      timeoutMs: 40_000,
    });
    return {
      check: { name: 'preview', status: 'passed', durationMs: Math.round(performance.now() - startedAt) },
      diagnostics: [],
    };
  } catch (error) {
    args.abortSignal.throwIfAborted();
    const diagnostics = parseOperationDiagnostics(commandDiagnosticText(error), {
      operation: 'validation',
      check: 'preview',
    });
    return {
      check: {
        name: 'preview',
        status: 'failed',
        durationMs: Math.round(performance.now() - startedAt),
        reason: 'The generated preview did not render cleanly.',
        diagnosticCount: diagnostics.length,
      },
      diagnostics,
    };
  } finally {
    previewProcess?.kill();
    if (previewOutputPromise) {
      void previewOutputPromise.catch(() => undefined);
    }
  }
}

function commandDiagnosticText(error: unknown): string {
  if (error instanceof ActionCommandExecutionError) {
    return error.output || error.message;
  }
  if (error instanceof ActionCommandTimeoutError) {
    return `${error.message}\n${error.output}`;
  }
  return error instanceof Error ? error.message : String(error);
}
