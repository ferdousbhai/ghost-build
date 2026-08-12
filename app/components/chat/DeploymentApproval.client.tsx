import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import type { PendingDeploymentApproval } from '~/lib/deployment-approval';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';
import { captureProductEvent } from '~/lib/telemetry.client';
import { Link } from '@tanstack/react-router';

export function DeploymentApproval({ deployment }: { deployment: PendingDeploymentApproval }) {
  const [activeDeployment, setActiveDeployment] = useState(deployment);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'retrying' | 'deploying' | 'deployed' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [productionUrl, setProductionUrl] = useState<string | null>(null);

  useEffect(() => {
    void captureProductEvent('deployment_approval_presented');
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void resumeDeployment(activeDeployment.id, abort.signal, () => setStatus('deploying'))
      .then((current) => {
        if (abort.signal.aborted || !current) {
          return;
        }
        setProductionUrl(current.productionUrl ?? null);
        setStatus('deployed');
        void captureProductEvent('deployment_succeeded', { outcome: 'success' });
      })
      .catch((resumeError) => {
        if (abort.signal.aborted) {
          return;
        }
        setCanRetry(resumeError instanceof DeploymentTerminalError);
        setError(resumeError instanceof Error ? resumeError.message : 'Unable to read production deployment status.');
        setStatus('error');
      });
    return () => abort.abort();
  }, [activeDeployment.id]);

  const continueDeployment = async () => {
    setStatus('deploying');
    setError(null);
    setCanRetry(false);
    try {
      const completed = await resumeDeployment(activeDeployment.id, undefined, () => setStatus('deploying'));
      if (!completed) {
        setStatus('idle');
        return;
      }
      setProductionUrl(completed.productionUrl ?? null);
      setStatus('deployed');
      void captureProductEvent('deployment_succeeded', { outcome: 'success' });
    } catch (deploymentError) {
      setCanRetry(deploymentError instanceof DeploymentTerminalError);
      setError(deploymentError instanceof Error ? deploymentError.message : 'Unable to resume the deployment.');
      setStatus('error');
    }
  };

  const approve = async () => {
    setStatus('submitting');
    setError(null);
    setCanRetry(false);
    try {
      const response = await deploymentFetch(activeDeployment.id, 'approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          planDigest: activeDeployment.planDigest,
          confirmCloudflareBilling: true,
          confirmWorkersPaidNotAutomatic: true,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        deployment?: { status?: string };
        error?: string;
      } | null;
      if (!response.ok || payload?.deployment?.status !== 'approved') {
        throw new Error(payload?.error || 'Unable to approve the deployment.');
      }
      void captureProductEvent('deployment_approved', { outcome: 'success' });
      await continueDeployment();
    } catch (approvalError) {
      setCanRetry(approvalError instanceof DeploymentTerminalError);
      setError(approvalError instanceof Error ? approvalError.message : 'Unable to approve the deployment.');
      setStatus('error');
    }
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
        throw new Error(payload?.error || 'Unable to prepare a deployment retry.');
      }
      setProductionUrl(null);
      setCanRetry(false);
      setActiveDeployment({ id: next.id, planDigest: next.planDigest, resources: next.plan.resources });
      setStatus('idle');
    } catch (retryError) {
      setCanRetry(true);
      setError(retryError instanceof Error ? retryError.message : 'Unable to prepare a deployment retry.');
      setStatus('error');
    }
  };

  return (
    <section className="mt-3 space-y-3 rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-4 text-sm">
      <div>
        <h3 className="text-content-primary font-medium">Ready to deploy</h3>
        <p className="text-content-secondary mt-1">Publish this app to your connected Cloudflare account.</p>
      </div>
      {status === 'deployed' ? (
        <p className="text-bolt-elements-icon-success">
          Deployed to your Cloudflare account.
          {productionUrl ? (
            <a className="ml-1 underline" href={productionUrl} target="_blank" rel="noreferrer">
              Open deployment
            </a>
          ) : null}
        </p>
      ) : status === 'deploying' ? (
        <p className="text-content-secondary">Provisioning and deploying in your Cloudflare account…</p>
      ) : status === 'retrying' ? (
        <p className="text-content-secondary">Preparing a fresh plan from the same immutable source…</p>
      ) : status === 'error' && canRetry ? (
        <Button size="sm" onClick={() => void retry()}>
          Prepare retry
        </Button>
      ) : status === 'error' ? (
        <Button size="sm" onClick={() => void continueDeployment()}>
          Resume deployment
        </Button>
      ) : (
        <Button size="lg" loading={status === 'submitting'} onClick={() => void approve()}>
          Deploy
        </Button>
      )}
      {status === 'idle' ? (
        <p className="max-w-2xl text-xs leading-relaxed text-content-tertiary">
          By clicking Deploy, you approve Cloudflare billing for this app&apos;s {activeDeployment.resources.length}{' '}
          resource{activeDeployment.resources.length === 1 ? '' : 's'} and inference. Ghostbuild never enables Workers
          Paid automatically.{' '}
          <Link className="underline underline-offset-4" to="/terms">
            Terms
          </Link>{' '}
          ·{' '}
          <Link className="underline underline-offset-4" to="/privacy">
            Privacy
          </Link>{' '}
          ·{' '}
          <Link className="underline underline-offset-4" to="/support">
            Support
          </Link>
        </p>
      ) : null}
      {error ? <p className="text-bolt-elements-icon-error">{error}</p> : null}
    </section>
  );
}

const DEPLOYMENT_POLL_INTERVAL_MS = 1_500;
const DEPLOYMENT_POLL_TIMEOUT_MS = 30 * 60 * 1_000;

async function resumeDeployment(
  deploymentId: string,
  signal: AbortSignal | undefined,
  onRunning: () => void,
): Promise<{ productionUrl?: string | null } | null> {
  const current = await getDeployment(deploymentId, signal);
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
  if (current.status === 'approved') {
    const response = await deploymentFetch(deploymentId, 'execute', {
      method: 'POST',
      signal,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error || 'Unable to resume the production deployment.');
    }
  }
  return pollDeployment(deploymentId, signal);
}

async function pollDeployment(deploymentId: string, signal?: AbortSignal): Promise<{ productionUrl?: string | null }> {
  const deadline = Date.now() + DEPLOYMENT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await getDeployment(deploymentId, signal);
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
};

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
