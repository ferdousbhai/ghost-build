import { useEffect } from 'react';
import type { BuilderDeploymentState } from '~/agents/builder-deployment-command';
import { Button } from '~/components/ui/primitives/Button';
import { captureProductEvent } from '~/lib/telemetry.client';

export function DeploymentStatus({
  deployment,
  onRetry,
}: {
  deployment: BuilderDeploymentState;
  onRetry?: () => Promise<BuilderDeploymentState>;
}) {
  useEffect(() => {
    if (deployment.status === 'succeeded') {
      void captureProductEvent('deployment_succeeded', { outcome: 'success' });
    }
  }, [deployment.status]);

  return (
    <section
      data-testid="deployment-status"
      // The browser gate reads this to prove production carries the revision that was saved.
      data-workspace-revision={deployment.workspaceRevision}
      className="mt-3 space-y-3 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-4 text-sm"
    >
      {deployment.status === 'succeeded' ? (
        <p className="text-bolt-elements-icon-success">
          Deployed.
          {deployment.productionUrl ? (
            <a className="ml-1 underline" href={deployment.productionUrl} target="_blank" rel="noreferrer">
              Open deployment
            </a>
          ) : null}
        </p>
      ) : deployment.status === 'failed' ? (
        <>
          <h3 className="text-content-primary font-medium">Deployment failed</h3>
          {deployment.error ? <p className="text-bolt-elements-icon-error">{deployment.error}</p> : null}
          {onRetry ? (
            <Button size="sm" onClick={() => void onRetry()}>
              Try again
            </Button>
          ) : null}
        </>
      ) : (
        <p className="text-content-secondary" role="status">
          Deploying…
        </p>
      )}
    </section>
  );
}
