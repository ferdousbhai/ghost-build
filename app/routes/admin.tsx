import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { BrandLink } from '~/components/BrandLink';
import { Button } from '~/components/ui/primitives/Button';
import { createPrivatePageHead } from '~/lib/social-meta';

type AdminOverview = {
  generatedAt: number;
  currentRuntimeVersion: string;
  metrics: {
    users: number;
    newThisWeek: number;
    newPreviousWeek: number;
    activeConnections: number;
    sessions: number;
  };
  runtimes: Array<{
    user_id: string;
    email: string;
    connection_id: string;
    status: string | null;
    runtime_version: string | null;
    last_error: string | null;
    updated_at: number | null;
    current: boolean;
  }>;
  upstreamRuns: Array<{
    id: string;
    status: 'ok' | 'attention' | 'error';
    started_at: number;
    completed_at: number;
    summary_json: string | null;
    error: string | null;
  }>;
};

export const Route = createFileRoute('/admin')({
  head: () => createPrivatePageHead('Operations | Ghostbuild', 'Owner-only Ghostbuild operations dashboard.'),
  component: AdminPage,
});

function AdminPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconciling, setReconciling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/overview', { credentials: 'same-origin' });
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? 'This dashboard is restricted to the Ghostbuild owner.'
            : 'Unable to load operations data.',
        );
      }
      setOverview((await response.json()) as AdminOverview);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load operations data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reconcile = async (userId: string) => {
    setReconciling(userId);
    setError(null);
    try {
      const response = await fetch('/api/admin/runtimes/reconcile', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? 'Unable to upgrade this workspace runtime.');
      }
      await refresh();
    } catch (reconcileError) {
      setError(reconcileError instanceof Error ? reconcileError.message : 'Unable to upgrade this workspace runtime.');
    } finally {
      setReconciling(null);
    }
  };

  return (
    <div className="min-h-svh bg-[#0d1110] px-4 py-5 text-[#e8ece7] sm:p-7">
      <div className="mx-auto max-w-7xl">
        <header className="border border-[#3b4741] bg-[#121816] p-5 shadow-[8px_8px_0_#050706] sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <BrandLink />
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#8ca198]">
                Owner control plane
              </span>
              <Button variant="neutral" size="sm" loading={loading} onClick={() => void refresh()}>
                Refresh
              </Button>
            </div>
          </div>
          <div className="mt-10 grid gap-5 lg:grid-cols-[1.4fr_0.6fr] lg:items-end">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.22em] text-[#47d7a0]">Ghostbuild / Operations</p>
              <h1 className="mt-3 max-w-3xl font-display text-[clamp(2.8rem,8vw,6.8rem)] font-black leading-[0.84] tracking-[-0.065em] text-white">
                Signal over noise.
              </h1>
            </div>
            <p className="max-w-md border-l-2 border-[#47d7a0] pl-4 text-sm leading-6 text-[#aab7b1] lg:justify-self-end">
              Account growth, runtime health, and durable upstream-review receipts. No prompts, project files, or
              secrets are exposed here.
            </p>
          </div>
        </header>

        {error ? (
          <div className="mt-5 border border-[#ff806d] bg-[#2b1714] px-4 py-3 text-sm text-[#ffd1ca]" role="alert">
            {error}
          </div>
        ) : null}

        {overview ? <Dashboard overview={overview} reconciling={reconciling} onReconcile={reconcile} /> : null}
        {!overview && loading ? (
          <p className="mt-8 font-mono text-sm text-[#8ca198]" role="status">
            Reading control-plane state…
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Dashboard({
  overview,
  reconciling,
  onReconcile,
}: {
  overview: AdminOverview;
  reconciling: string | null;
  onReconcile: (userId: string) => Promise<void>;
}) {
  const metrics = [
    ['Users', overview.metrics.users],
    ['New / 7d', overview.metrics.newThisWeek],
    ['Prior / 7d', overview.metrics.newPreviousWeek],
    ['Connected', overview.metrics.activeConnections],
    ['Live sessions', overview.metrics.sessions],
  ] as const;
  return (
    <>
      <section className="mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Platform metrics">
        {metrics.map(([label, value], index) => (
          <article key={label} className="relative overflow-hidden border border-[#3b4741] bg-[#151c19] p-5">
            <span className="absolute right-3 top-3 font-mono text-[10px] text-[#617169]">0{index + 1}</span>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-[#8ca198]">{label}</p>
            <p className="mt-5 text-5xl font-black tracking-[-0.06em] text-white">{value}</p>
          </article>
        ))}
      </section>

      <section className="mt-7 border border-[#3b4741] bg-[#121816]" aria-labelledby="runtime-health-heading">
        <SectionHeading id="runtime-health-heading" index="A" title="Workspace runtimes" />
        <div className="divide-y divide-[#2c3732]">
          {overview.runtimes.map((runtime) => (
            <article key={runtime.user_id} className="grid gap-4 p-5 md:grid-cols-[1fr_auto] md:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="truncate font-medium text-white">{runtime.email}</p>
                  <StatusBadge status={runtime.current ? 'ok' : runtime.status === 'error' ? 'error' : 'attention'}>
                    {runtime.current ? 'current' : (runtime.status ?? 'missing')}
                  </StatusBadge>
                </div>
                <p className="mt-2 break-words font-mono text-[11px] text-[#72847b]">
                  {runtime.runtime_version?.slice(0, 16) ?? 'no runtime'} · updated {formatTime(runtime.updated_at)}
                </p>
                {runtime.last_error ? (
                  <p className="mt-3 line-clamp-2 max-w-4xl text-xs leading-5 text-[#d99b90]">{runtime.last_error}</p>
                ) : null}
              </div>
              {!runtime.current ? (
                <Button
                  size="sm"
                  loading={reconciling === runtime.user_id}
                  disabled={reconciling !== null && reconciling !== runtime.user_id}
                  onClick={() => void onReconcile(runtime.user_id)}
                >
                  Upgrade runtime
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="mt-7 border border-[#3b4741] bg-[#121816]" aria-labelledby="upstream-heading">
        <SectionHeading id="upstream-heading" index="B" title="Upstream monitor receipts" />
        {overview.upstreamRuns.length === 0 ? (
          <p className="p-5 text-sm text-[#8ca198]">No weekly run has been recorded yet.</p>
        ) : (
          <div className="divide-y divide-[#2c3732]">
            {overview.upstreamRuns.map((run) => (
              <article key={run.id} className="grid gap-3 p-5 md:grid-cols-[auto_1fr_auto] md:items-center">
                <StatusBadge status={run.status}>{run.status}</StatusBadge>
                <div>
                  <p className="text-sm text-[#d9e0dc]">{monitorSummary(run)}</p>
                  {run.error ? <p className="mt-1 text-xs text-[#d99b90]">{run.error}</p> : null}
                </div>
                <time
                  className="font-mono text-[11px] text-[#72847b]"
                  dateTime={new Date(run.completed_at).toISOString()}
                >
                  {formatTime(run.completed_at)}
                </time>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function SectionHeading({ id, index, title }: { id: string; index: string; title: string }) {
  return (
    <div className="flex items-center gap-4 border-b border-[#3b4741] px-5 py-4">
      <span className="font-mono text-xs text-[#47d7a0]">{index}</span>
      <h2 id={id} className="font-display text-xl font-bold text-white">
        {title}
      </h2>
    </div>
  );
}

function StatusBadge({
  status,
  children,
}: {
  status: 'ok' | 'attention' | 'error' | string;
  children: React.ReactNode;
}) {
  const color =
    status === 'ok'
      ? 'border-[#3b8f6d] bg-[#153327] text-[#77e2b7]'
      : status === 'error'
        ? 'border-[#9b4a3e] bg-[#361b17] text-[#ff9c8c]'
        : 'border-[#9a7a2f] bg-[#332a13] text-[#f2ca61]';
  return (
    <span className={`inline-flex w-fit border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${color}`}>
      {children}
    </span>
  );
}

function monitorSummary(run: AdminOverview['upstreamRuns'][number]): string {
  if (!run.summary_json) {
    return run.status === 'error' ? 'Weekly monitor failed.' : 'Weekly monitor completed.';
  }
  try {
    const summary = JSON.parse(run.summary_json) as {
      audit?: { addedSkills?: unknown[]; removedSkills?: unknown[]; changedTrackedFiles?: unknown[] };
      canary?: { endpointCount?: number };
    };
    const added = summary.audit?.addedSkills?.length ?? 0;
    const removed = summary.audit?.removedSkills?.length ?? 0;
    const changed = summary.audit?.changedTrackedFiles?.length ?? 0;
    return `${changed} tracked file${changed === 1 ? '' : 's'} changed · ${added} skill${added === 1 ? '' : 's'} added · ${removed} removed · ${summary.canary?.endpointCount ?? 0} model endpoint${summary.canary?.endpointCount === 1 ? '' : 's'}`;
  } catch {
    return 'Stored monitor receipt is invalid.';
  }
}

function formatTime(value: number | null): string {
  if (!value) {
    return 'never';
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}
