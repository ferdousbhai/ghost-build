export function CloudflareConnectLegalNotice({ className = '' }: { className?: string }) {
  return (
    <p className={className} data-testid="cloudflare-connect-legal-notice">
      By connecting Cloudflare, you authorize the account access described in the{' '}
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
