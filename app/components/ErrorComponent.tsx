import { ExclamationTriangleIcon, ReloadIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { LinkButton } from '~/components/ui/LinkButton';
import { BrandLink } from '~/components/BrandLink';

interface ErrorDisplayProps {
  error: Error | unknown;
  resetErrorBoundary?: () => void;
}

export function ErrorDisplay({ error, resetErrorBoundary }: ErrorDisplayProps) {
  const isError = error instanceof Error;
  const message = isError ? error.message : String(error);
  const retry = resetErrorBoundary ?? (() => window.location.reload());

  return (
    <main className="app-page-shell flex min-h-svh items-center px-4 py-10" role="alert" aria-live="assertive">
      <div className="app-error-card app-card mx-auto">
        <div className="mb-6">
          <BrandLink />
        </div>

        <ExclamationTriangleIcon className="mb-4 size-7 text-[var(--gb-content-warning)]" aria-hidden />
        <h1 className="app-page-title !text-[clamp(34px,6vw,52px)]">This page could not load.</h1>
        <p className="app-page-lede break-words">{message || 'Ghostbuild encountered an unexpected error.'}</p>

        <div className="mt-7 flex flex-wrap gap-3">
          <Button onClick={retry} icon={<ReloadIcon aria-hidden />}>
            Try again
          </Button>
          <LinkButton to="/" variant="neutral">
            Back to Ghostbuild
          </LinkButton>
        </div>

        {import.meta.env.DEV && isError && error.stack && (
          <details className="mt-8 text-sm text-content-secondary">
            <summary className="cursor-pointer font-semibold">Technical details</summary>
            <pre className="app-error-code mt-3">{error.stack}</pre>
          </details>
        )}
      </div>
    </main>
  );
}
