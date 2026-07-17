import type { WebContainer } from '@webcontainer/api';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';
import { getAuthToken } from '~/lib/stores/sessionId';
import { chatIdStore } from '~/lib/stores/chatId';
import type { ActionRunnerWorkspace } from './types';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { deployToolParameters } from 'ghostbuild-agent/tools/deploy';
import { workspaceRevision } from './revision';

const logger = createScopedLogger('ActionRunner.Deploy');
const DEPLOYMENT_EXPORT_EXCLUDES = [
  'node_modules/**',
  'dist/**',
  '.output/**',
  '.tanstack/**',
  '.wrangler/**',
  '.env',
  '.env.*',
  '.dev.vars',
  '.dev.vars.*',
  '.envrc',
];

export async function runDeploy(args: {
  invocation: GhostbuildToolInvocation;
  container: WebContainer;
  abortSignal: AbortSignal;
  workspace: ActionRunnerWorkspace;
}) {
  const startedAt = performance.now();
  const sessionId = getAuthToken();
  if (!sessionId) {
    return toolFailure('Production deployment requires Cloudflare. The validated project remains ready for preview.', {
      state: 'sign-in-required',
    });
  }
  const input = deployToolParameters.parse(args.invocation.args);
  await waitForContainerBootState(ContainerBootState.READY);
  args.abortSignal.throwIfAborted();
  const revisionBeforeExport = await workspaceRevision(args.workspace.getFiles());
  if (revisionBeforeExport !== input.validatedRevision) {
    return toolFailure(
      'The workspace changed after validation. Run a full validateProject check for the current revision before preparing deployment.',
      {
        state: 'validation-stale',
        validatedRevision: input.validatedRevision,
        currentRevision: revisionBeforeExport,
      },
    );
  }
  const snapshot = await args.container.export('.', {
    format: 'zip',
    excludes: DEPLOYMENT_EXPORT_EXCLUDES,
  });
  const revisionAfterExport = await workspaceRevision(args.workspace.getFiles());
  if (revisionAfterExport !== revisionBeforeExport) {
    return toolFailure(
      'The workspace changed while the deployment snapshot was being captured. Validate the current revision again.',
      {
        state: 'validation-stale',
        validatedRevision: input.validatedRevision,
        currentRevision: revisionAfterExport,
      },
    );
  }
  const deployment = await prepareProductionDeployment(snapshot, args.abortSignal);
  logger.info('deploy action finished in', performance.now() - startedAt);
  return toolSuccess(
    'Deployment plan ready for explicit approval. The isolated executor will revalidate before provisioning.',
    { state: 'awaiting-approval', revision: revisionAfterExport, deployment },
  );
}

async function prepareProductionDeployment(snapshot: Uint8Array, abortSignal: AbortSignal) {
  abortSignal.throwIfAborted();
  const ownedSnapshot = new Uint8Array(snapshot.byteLength);
  ownedSnapshot.set(snapshot);
  const formData = new FormData();
  formData.append('snapshot', new Blob([ownedSnapshot.buffer], { type: 'application/zip' }));
  const chatId = chatIdStore.get();
  const response = await fetch(`/api/deployments/plan?chatId=${encodeURIComponent(chatId)}`, {
    method: 'POST',
    body: formData,
    signal: abortSignal,
  });
  const payload = (await response.json().catch(() => null)) as DeploymentPlanResponse | { error?: string } | null;
  if (!response.ok || !payload || !('deployment' in payload)) {
    const message = payload && 'error' in payload ? payload.error : undefined;
    throw new Error(message || `Unable to prepare production deployment (${response.status}).`);
  }
  return {
    id: payload.deployment.id,
    planDigest: payload.deployment.planDigest,
    resources: payload.deployment.plan.resources,
  };
}

type DeploymentPlanResponse = {
  deployment: {
    id: string;
    planDigest: string;
    plan: {
      resources: Array<{ type: string; logicalName: string; proposedName: string }>;
    };
  };
};
