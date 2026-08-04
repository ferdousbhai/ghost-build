import { TRUST_LINKS } from '~/lib/trust';

export function TrustLinks({ className = '' }: { className?: string }) {
  return (
    <nav
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-content-tertiary ${className}`}
      aria-label="Trust and legal"
    >
      {TRUST_LINKS.map(({ href, label }) => (
        <a
          key={href}
          href={href}
          className="rounded-sm underline decoration-transparent underline-offset-4 transition hover:decoration-current focus-visible:decoration-current"
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

export function TrustFooter({ className = '' }: { className?: string }) {
  return (
    <footer className={`border-t border-bolt-elements-borderColor p-4 sm:px-6 ${className}`}>
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-content-tertiary">
          Ghostbuild is open source. Customer Cloudflare accounts own generated resources.
        </p>
        <TrustLinks />
      </div>
    </footer>
  );
}
