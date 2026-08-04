export function CloudflareConnectLegalNotice({ className = '' }: { className?: string }) {
  return (
    <p className={className} data-testid="cloudflare-connect-legal-notice">
      By connecting, you authorize Ghostbuild to create and use project resources in this Cloudflare account as
      described in the{' '}
      <a href="/privacy" className="underline underline-offset-4">
        Privacy notice
      </a>{' '}
      and agree to the{' '}
      <a href="/terms" className="underline underline-offset-4">
        Terms
      </a>
      .
    </p>
  );
}
