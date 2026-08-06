import { Link } from '@tanstack/react-router';

export function CloudflareConnectLegalNotice({ className = '' }: { className?: string }) {
  return (
    <p className={className} data-testid="cloudflare-connect-legal-notice">
      By connecting, you authorize Ghostbuild to create and use project resources in this Cloudflare account as
      described in the{' '}
      <Link to="/privacy" className="underline underline-offset-4">
        Privacy notice
      </Link>{' '}
      and agree to the{' '}
      <Link to="/terms" className="underline underline-offset-4">
        Terms
      </Link>
      .
    </p>
  );
}
