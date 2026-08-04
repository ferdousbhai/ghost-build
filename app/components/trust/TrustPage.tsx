import type { ReactNode } from 'react';
import { BrandLink } from '~/components/BrandLink';
import {
  TRUST_DOCUMENT_EFFECTIVE_DATE,
  TRUST_DOCUMENT_EFFECTIVE_ISO_DATE,
  TRUST_DOCUMENT_STATUS,
  TRUST_DOCUMENT_VERSION,
} from '~/lib/trust';
import { TrustLinks } from './TrustLinks';

export function TrustPage({
  eyebrow,
  title,
  summary,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <div className="trust-page min-h-svh">
      <header className="trust-page__header">
        <BrandLink />
        <TrustLinks />
      </header>
      <div className="trust-page__layout">
        <aside className="trust-page__rail" aria-label="Document status">
          <p>{TRUST_DOCUMENT_VERSION}</p>
          <p>Effective date</p>
          <time dateTime={TRUST_DOCUMENT_EFFECTIVE_ISO_DATE}>{TRUST_DOCUMENT_EFFECTIVE_DATE}</time>
        </aside>
        <article className="trust-page__article">
          <p className="app-page-eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="trust-page__summary">{summary}</p>
          <div className="trust-page__notice" role="note">
            <strong>Public beta.</strong> {TRUST_DOCUMENT_STATUS}
          </div>
          <div className="trust-page__prose">{children}</div>
        </article>
      </div>
    </div>
  );
}

export function TrustSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
