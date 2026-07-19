import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { buildApprovedDeploymentArtifact, publishApprovedDeploymentArtifact } from './deployment-executor';

type DeploymentWorkflowParams = {
  deploymentId: string;
  userId: string;
  connectionId: string;
  executionGeneration: number;
};

/**
 * Keeps user-approved production execution alive independently of the browser
 * request that triggered it. The durable R2 receipt separates the isolated
 * build from provider mutations so every step stays within this project's
 * conservative 30-minute operational budget. Retries remain disabled: the
 * execution generation isolates manual retries, while deterministic provider
 * names support reconciliation of calls that can be billable.
 */
export class DeploymentWorkflow extends WorkflowEntrypoint<Env, DeploymentWorkflowParams> {
  override async run(event: WorkflowEvent<DeploymentWorkflowParams>, step: WorkflowStep) {
    const params = requireWorkflowParams(event.payload);
    const receipt = await step.do(
      'claim, build, and persist approved deployment artifact',
      { retries: { limit: 0, delay: '1 second' }, timeout: '30 minutes' },
      () => buildApprovedDeploymentArtifact({ env: this.env, ...params }),
    );
    return step.do(
      'verify artifact, provision, publish, and clean up deployment',
      { retries: { limit: 0, delay: '1 second' }, timeout: '30 minutes' },
      async () => {
        const deployment = await publishApprovedDeploymentArtifact({ env: this.env, ...params, receipt });
        return {
          deploymentId: deployment.id,
          status: deployment.status,
          productionUrl: deployment.productionUrl,
        };
      },
    );
  }
}

function requireWorkflowParams(value: unknown): DeploymentWorkflowParams {
  if (!value || typeof value !== 'object') {
    throw new Error('Deployment Workflow parameters are missing.');
  }
  const params = value as Partial<DeploymentWorkflowParams>;
  for (const key of ['deploymentId', 'userId', 'connectionId'] as const) {
    if (typeof params[key] !== 'string' || params[key].length < 1 || params[key].length > 200) {
      throw new Error(`Deployment Workflow ${key} is invalid.`);
    }
  }
  if (!Number.isSafeInteger(params.executionGeneration) || (params.executionGeneration ?? 0) < 1) {
    throw new Error('Deployment Workflow executionGeneration is invalid.');
  }
  return params as DeploymentWorkflowParams;
}
