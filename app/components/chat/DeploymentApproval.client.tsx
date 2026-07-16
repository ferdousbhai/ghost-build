import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import { Checkbox } from '~/components/ui/primitives/Checkbox';
import type { PendingDeploymentApproval } from './deployment-approval';

export function DeploymentApproval({ deployment }: { deployment: PendingDeploymentApproval }) {
  const [activeDeployment, setActiveDeployment] = useState(deployment);
  const [billingApproved, setBillingApproved] = useState(false);
  const [paidPolicyUnderstood, setPaidPolicyUnderstood] = useState(false);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'retrying' | 'deploying' | 'deployed' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [productionUrl, setProductionUrl] = useState<string | null>(null);
  const controlsDisabled =
    status === 'submitting' || status === 'retrying' || status === 'deploying' || status === 'deployed';

  useEffect(() => {
    const abort = new AbortController();
    void resumeDeployment(activeDeployment.id, abort.signal, () => setStatus('deploying'))
      .then((current) => {
        if (abort.signal.aborted || !current) {
          return;
        }
        setProductionUrl(current.productionUrl ?? null);
        setStatus('deployed');
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
      const response = await fetch(`/api/deployments/${encodeURIComponent(activeDeployment.id)}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          planDigest: activeDeployment.planDigest,
          confirmCloudflareBilling: billingApproved,
          confirmWorkersPaidNotAutomatic: paidPolicyUnderstood,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        deployment?: { status?: string };
        error?: string;
      } | null;
      if (!response.ok || payload?.deployment?.status !== 'approved') {
        throw new Error(payload?.error || 'Unable to approve the deployment.');
      }
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
      const response = await fetch(`/api/deployments/${encodeURIComponent(activeDeployment.id)}/retry`, {
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
      setBillingApproved(false);
      setPaidPolicyUnderstood(false);
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
    <section className="mt-3 space-y-3 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-4 text-sm">
      <div>
        <h3 className="text-content-primary font-medium">Approve production deployment</h3>
        <p className="text-content-secondary mt-1">
          {activeDeployment.resources.length} Cloudflare resources will be provisioned in your connected account.
        </p>
      </div>
      <label className="text-content-primary flex items-start gap-2">
        <Checkbox
          checked={billingApproved}
          disabled={controlsDisabled}
          onChange={(event) => setBillingApproved(event.target.checked)}
        />
        <span>I approve Cloudflare billing my account for this project&apos;s infrastructure and inference.</span>
      </label>
      <label className="text-content-primary flex items-start gap-2">
        <Checkbox
          checked={paidPolicyUnderstood}
          disabled={controlsDisabled}
          onChange={(event) => setPaidPolicyUnderstood(event.target.checked)}
        />
        <span>I understand Workers Paid will require separate authorization and is not enabled automatically.</span>
      </label>
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
        <Button
          size="sm"
          loading={status === 'submitting'}
          disabled={!billingApproved || !paidPolicyUnderstood}
          onClick={() => void approve()}
        >
          Approve deployment
        </Button>
      )}
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
    const response = await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}/execute`, {
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
  const response = await fetch(`/api/deployments/${encodeURIComponent(deploymentId)}`, { signal });
  const payload = (await response.json().catch(() => null)) as {
    deployment?: DeploymentStatusPayload;
    error?: string;
  } | null;
  if (!response.ok || !payload?.deployment) {
    throw new Error(payload?.error || 'Unable to read production deployment status.');
  }
  return payload.deployment;
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
