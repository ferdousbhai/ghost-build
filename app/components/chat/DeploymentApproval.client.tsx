import { useCallback, useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import type { PendingDeploymentApproval } from '~/lib/deployment-approval';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';
import { captureProductEvent } from '~/lib/telemetry.client';

export function DeploymentApproval({
  deployment,
  onPrepareDeployment,
}: {
  deployment: PendingDeploymentApproval;
  onPrepareDeployment?: () => Promise<PendingDeploymentApproval>;
}) {
  const [activeDeployment, setActiveDeployment] = useState(deployment);
  const [status, setStatus] = useState<'submitting' | 'retrying' | 'deploying' | 'deployed' | 'error'>('submitting');
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [productionUrl, setProductionUrl] = useState<string | null>(null);
  const [activity, setActivity] = useState<DeploymentActivity[]>([]);
  const visibleError = error && !/^Deployment cannot continue from status \w+\.?$/u.test(error) ? error : null;

  const deploy = useCallback(async (target: PendingDeploymentApproval, signal?: AbortSignal) => {
    setStatus('submitting');
    setError(null);
    setCanRetry(false);
    setActivity([]);
    try {
      const completed = await approveAndResumeDeployment(target, signal, () => setStatus('deploying'), setActivity);
      if (signal?.aborted) {
        return;
      }
      setProductionUrl(completed.productionUrl ?? null);
      setStatus('deployed');
      void captureProductEvent('deployment_succeeded', { outcome: 'success' });
    } catch (deploymentError) {
      if (signal?.aborted) {
        return;
      }
      setCanRetry(deploymentError instanceof DeploymentTerminalError);
      setError(publicDeploymentError(deploymentError, 'Unable to deploy the app.'));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void deploy(activeDeployment, abort.signal);
    return () => abort.abort();
  }, [activeDeployment, deploy]);

  const continueDeployment = async () => {
    await deploy(activeDeployment);
  };

  const retry = async () => {
    setStatus('retrying');
    setError(null);
    try {
      const response = await deploymentFetch(activeDeployment.id, 'retry', {
        method: 'POST',
      });
      const payload = (await response.json().catch(() => null)) as {
        deployment?: {
          id?: string;
          planDigest?: string;
          plan?: { resources?: PendingDeploymentApproval['resources'] };
        };
        error?: string;
      } | null;
      const next = payload?.deployment;
      if (!response.ok || !next?.id || !next.planDigest || !next.plan?.resources) {
        if (onPrepareDeployment) {
          const preparedCurrent = await onPrepareDeployment();
          setProductionUrl(null);
          setCanRetry(false);
          setActiveDeployment(preparedCurrent);
          return;
        }
        throw new Error(payload?.error || 'Unable to prepare a deployment retry.');
      }
      setProductionUrl(null);
      setCanRetry(false);
      const prepared = { id: next.id, planDigest: next.planDigest, resources: next.plan.resources };
      await deploy(prepared);
    } catch (retryError) {
      setCanRetry(true);
      setError(publicDeploymentError(retryError, 'Unable to prepare a deployment retry.'));
      setStatus('error');
    }
  };

  return (
    <section className="mt-3 space-y-3 rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-4 text-sm">
      {status === 'deployed' ? (
        <p className="text-bolt-elements-icon-success">
          Deployed.
          {productionUrl ? (
            <a className="ml-1 underline" href={productionUrl} target="_blank" rel="noreferrer">
              Open deployment
            </a>
          ) : null}
        </p>
      ) : status === 'error' && canRetry ? (
        <>
          <h3 className="text-content-primary font-medium">Deployment failed</h3>
          <Button size="sm" onClick={() => void retry()}>
            Try again
          </Button>
        </>
      ) : status === 'error' ? (
        <>
          <h3 className="text-content-primary font-medium">Deployment failed</h3>
          <Button size="sm" onClick={() => void continueDeployment()}>
            Try again
          </Button>
        </>
      ) : (
        <div className="space-y-2" role="status" aria-live="polite">
          <p className="text-content-primary font-medium">Deploying…</p>
          {activity.length > 0 ? (
            <ol className="space-y-1 font-mono text-xs text-content-secondary" aria-label="Deployment activity">
              {activity.map((entry, index) => (
                <li key={entry.sequence} className="flex gap-2">
                  <span aria-hidden="true">{index === activity.length - 1 ? '›' : '✓'}</span>
                  <span>{entry.message}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-content-secondary">Starting Cloudflare deployment…</p>
          )}
        </div>
      )}
      {visibleError ? <p className="text-bolt-elements-icon-error">{visibleError}</p> : null}
    </section>
  );
}

const DEPLOYMENT_POLL_INTERVAL_MS = 1_500;
const DEPLOYMENT_POLL_TIMEOUT_MS = 30 * 60 * 1_000;

async function approveAndResumeDeployment(
  deployment: PendingDeploymentApproval,
  signal: AbortSignal | undefined,
  onRunning: () => void,
  onActivity: (activity: DeploymentActivity[]) => void,
): Promise<{ productionUrl?: string | null }> {
  const current = await getDeployment(deployment.id, signal);
  if (current.status === 'awaiting_approval') {
    const response = await deploymentFetch(deployment.id, 'approve', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planDigest: deployment.planDigest,
        confirmCloudflareBilling: true,
        confirmWorkersPaidNotAutomatic: true,
      }),
    });
    const payload = (await response.json().catch(() => null)) as {
      deployment?: { status?: string };
      error?: string;
    } | null;
    if (!response.ok || payload?.deployment?.status !== 'approved') {
      throw new Error(payload?.error || 'Unable to start deployment.');
    }
  }
  const completed = await resumeDeployment(deployment.id, signal, onRunning, onActivity);
  if (!completed) {
    throw new Error('Unable to start deployment.');
  }
  return completed;
}

async function resumeDeployment(
  deploymentId: string,
  signal: AbortSignal | undefined,
  onRunning: () => void,
  onActivity: (activity: DeploymentActivity[]) => void,
): Promise<{ productionUrl?: string | null } | null> {
  const current = await getDeployment(deploymentId, signal);
  onActivity(current.activity ?? []);
  if (current.status === 'awaiting_approval') {
    return null;
  }
  if (current.status === 'succeeded') {
    return current;
  }
  if (current.status === 'failed' || current.status === 'canceled') {
    throw new DeploymentTerminalError(current.error?.message || 'Production deployment failed.');
  }
  onRunning();
  let executionError: unknown = null;
  if (current.status === 'approved') {
    void deploymentFetch(deploymentId, 'execute', {
      method: 'POST',
      signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error || 'Unable to resume the production deployment.');
        }
      })
      .catch((error) => {
        if (!signal?.aborted) {
          executionError = error;
        }
      });
  }
  return pollDeployment(deploymentId, signal, onActivity, () => executionError);
}

async function pollDeployment(
  deploymentId: string,
  signal: AbortSignal | undefined,
  onActivity: (activity: DeploymentActivity[]) => void,
  executionError: () => unknown,
): Promise<{ productionUrl?: string | null }> {
  const deadline = Date.now() + DEPLOYMENT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await getDeployment(deploymentId, signal);
    onActivity(current.activity ?? []);
    if (current.status === 'approved' && executionError()) {
      throw executionError();
    }
    if (current.status === 'succeeded') {
      return current;
    }
    if (current.status === 'failed' || current.status === 'canceled') {
      throw new DeploymentTerminalError(current.error?.message || 'Production deployment failed.');
    }
    await abortableDelay(DEPLOYMENT_POLL_INTERVAL_MS, signal);
  }
  throw new Error('Production deployment is still running. Check its status again shortly.');
}

class DeploymentTerminalError extends Error {
  override name = 'DeploymentTerminalError';
}

type DeploymentStatusPayload = {
  status?: string;
  productionUrl?: string | null;
  error?: { message?: string } | null;
  activity?: DeploymentActivity[];
};

type DeploymentActivity = { sequence: number; message: string; createdAt: number };

function publicDeploymentError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  return error.message.split('\n', 1)[0]?.trim().slice(0, 240) || fallback;
}

async function getDeployment(deploymentId: string, signal?: AbortSignal): Promise<DeploymentStatusPayload> {
  const response = await deploymentFetch(deploymentId, undefined, { signal });
  const payload = (await response.json().catch(() => null)) as {
    deployment?: DeploymentStatusPayload;
    error?: string;
  } | null;
  if (!response.ok || !payload?.deployment) {
    throw new Error(payload?.error || 'Unable to read production deployment status.');
  }
  return payload.deployment;
}

function deploymentFetch(deploymentId: string, operation?: 'approve' | 'execute' | 'retry', init?: RequestInit) {
  const suffix = operation ? `/${operation}` : '';
  return fetchUserRuntime(`/v1/deployments/${encodeURIComponent(deploymentId)}${suffix}`, init);
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
