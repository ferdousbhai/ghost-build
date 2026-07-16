import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { executeApprovedDeployment } from './deployment-executor';

type DeploymentWorkflowParams = {
  deploymentId: string;
  userId: string;
  connectionId: string;
};

/**
 * Keeps user-approved production execution alive independently of the browser
 * request that triggered it. The executor owns the D1 state machine and is
 * deliberately not retried: provisioning and publish are external side
 * effects, so an automatic retry could create additional billable resources.
 */
export class DeploymentWorkflow extends WorkflowEntrypoint<Env, DeploymentWorkflowParams> {
  override async run(event: WorkflowEvent<DeploymentWorkflowParams>, step: WorkflowStep) {
    const params = requireWorkflowParams(event.payload);
    return step.do(
      'execute approved Cloudflare deployment',
      { retries: { limit: 0, delay: '1 second' }, timeout: '30 minutes' },
      async () => {
        const deployment = await executeApprovedDeployment({ env: this.env, ...params });
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
  return params as DeploymentWorkflowParams;
}
