import type { WebContainer } from '@webcontainer/api';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { ContainerBootState, waitForContainerBootState } from '~/lib/stores/containerBootState';
import { getAuthToken } from '~/lib/stores/sessionId';
import { chatIdStore } from '~/lib/stores/chatId';
import type { ActionRunnerWorkspace } from './types';
import { toolFailure, toolSuccess } from 'ghostbuild-agent/tool-result';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { deployToolParameters } from 'ghostbuild-agent/tools/deploy';
import { deploymentSnapshotRevision, exportDeploymentSnapshot } from './revision';
import type { DeploymentValidationStore } from './deployment-validation-store';

const logger = createScopedLogger('ActionRunner.Deploy');
export async function runDeploy(args: {
  invocation: GhostbuildToolInvocation;
  container: WebContainer;
  abortSignal: AbortSignal;
  workspace: ActionRunnerWorkspace;
  deploymentValidation: DeploymentValidationStore;
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
  const snapshot = await exportDeploymentSnapshot(args.container);
  args.abortSignal.throwIfAborted();
  const snapshotRevision = await deploymentSnapshotRevision(snapshot);
  if (!args.deploymentValidation.hasFullValidation(input.validatedRevision)) {
    return toolFailure(
      'Deployment requires a successful full validateProject check from this workspace session. Run full validation before preparing deployment.',
      {
        state: 'validation-required',
        requestedRevision: input.validatedRevision,
        currentRevision: snapshotRevision,
      },
    );
  }
  if (snapshotRevision !== input.validatedRevision) {
    return toolFailure(
      'The workspace changed after validation. Run a full validateProject check for the current revision before preparing deployment.',
      {
        state: 'validation-stale',
        validatedRevision: input.validatedRevision,
        currentRevision: snapshotRevision,
      },
    );
  }
  const deployment = await prepareProductionDeployment(snapshot, args.abortSignal);
  logger.info('deploy action finished in', performance.now() - startedAt);
  return toolSuccess(
    'Deployment plan ready for explicit approval. The isolated executor will revalidate before provisioning.',
    { state: 'awaiting-approval', revision: snapshotRevision, deployment },
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
