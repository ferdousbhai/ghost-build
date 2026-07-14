import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/primitives/Button';
import { Checkbox } from '~/components/ui/primitives/Checkbox';
import type { PendingDeploymentApproval } from './deployment-approval';

export function DeploymentApproval({ deployment }: { deployment: PendingDeploymentApproval }) {
  const [billingApproved, setBillingApproved] = useState(false);
  const [paidPolicyUnderstood, setPaidPolicyUnderstood] = useState(false);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'deploying' | 'deployed' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [productionUrl, setProductionUrl] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void resumeDeployment(deployment.id, abort.signal, () => setStatus('deploying'))
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
        setError(resumeError instanceof Error ? resumeError.message : 'Unable to read production deployment status.');
        setStatus('error');
      });
    return () => abort.abort();
  }, [deployment.id]);

  const approve = async () => {
    setStatus('submitting');
    setError(null);
    try {
      const response = await fetch(`/api/deployments/${encodeURIComponent(deployment.id)}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          planDigest: deployment.planDigest,
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
      setStatus('deploying');
      const executionResponse = await fetch(`/api/deployments/${encodeURIComponent(deployment.id)}/execute`, {
        method: 'POST',
      });
      const executionPayload = (await executionResponse.json().catch(() => null)) as {
        deployment?: { status?: string; productionUrl?: string | null };
        error?: string;
      } | null;
      if (!executionResponse.ok || !executionPayload?.deployment) {
        throw new Error(executionPayload?.error || 'Unable to start the production deployment.');
      }
      const completed = await waitForDeployment(deployment.id);
      setProductionUrl(completed.productionUrl ?? null);
      setStatus('deployed');
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Unable to approve the deployment.');
      setStatus('error');
    }
  };

  return (
    <section className="mt-3 space-y-3 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-4 text-sm">
      <div>
        <h3 className="text-content-primary font-medium">Approve production deployment</h3>
        <p className="text-content-secondary mt-1">
          {deployment.resources.length} Cloudflare resources will be provisioned in your connected account.
        </p>
      </div>
      <label className="text-content-primary flex items-start gap-2">
        <Checkbox
          checked={billingApproved}
          disabled={status === 'submitting' || status === 'deploying' || status === 'deployed'}
          onChange={(event) => setBillingApproved(event.target.checked)}
        />
        <span>I approve Cloudflare billing my account for this app&apos;s infrastructure and inference.</span>
      </label>
      <label className="text-content-primary flex items-start gap-2">
        <Checkbox
          checked={paidPolicyUnderstood}
          disabled={status === 'submitting' || status === 'deploying' || status === 'deployed'}
          onChange={(event) => setPaidPolicyUnderstood(event.target.checked)}
        />
        <span>I understand Workers Paid will require separate authorization and is not enabled automatically.</span>
      </label>
      {status === 'deployed' ? (
        <p className="text-bolt-elements-icon-success">
          Deployed to your Cloudflare account.
          {productionUrl ? (
            <a className="ml-1 underline" href={productionUrl} target="_blank" rel="noreferrer">
              Open app
            </a>
          ) : null}
        </p>
      ) : status === 'deploying' ? (
        <p className="text-content-secondary">Provisioning and deploying in your Cloudflare account…</p>
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

async function waitForDeployment(deploymentId: string): Promise<{ productionUrl?: string | null }> {
  return pollDeployment(deploymentId);
}

async function resumeDeployment(
  deploymentId: string,
  signal: AbortSignal,
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
    throw new Error(current.error?.message || 'Production deployment failed.');
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
      throw new Error(current.error?.message || 'Production deployment failed.');
    }
    await abortableDelay(DEPLOYMENT_POLL_INTERVAL_MS, signal);
  }
  throw new Error('Production deployment is still running. Check its status again shortly.');
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
