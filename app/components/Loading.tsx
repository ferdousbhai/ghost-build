import { Spinner } from '@ui/Spinner';

export function Loading(props: { message?: string }) {
  return (
    <div
      className="app-loading-state flex h-full min-h-80 flex-col items-center justify-center gap-4 px-6 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="app-loading-mark" aria-hidden>
        <Spinner />
      </div>
      <div>
        <p className="font-display text-sm font-black text-content-primary">Preparing Ghostbuild</p>
        <p className="mt-1 text-sm text-content-secondary">{props.message ?? 'Loading…'}</p>
      </div>
    </div>
  );
}
