import { createFileRoute } from '@tanstack/react-router';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import { GHOSTBUILD_SUPPORT_URL, TRUST_CHANNEL_STATUS, createPublicBetaTrustPageHead } from '~/lib/trust';

export const Route = createFileRoute('/support')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Support | Ghostbuild',
      description: 'Get product, account, and privacy help for Ghostbuild.',
      path: '/support',
    }),
  component: SupportPage,
});

function SupportPage() {
  return (
    <TrustPage
      eyebrow="Support"
      title="Get help in the open."
      summary="Use the structured GitHub support form for product, billing-boundary, account, export, or deletion questions. Never include credentials or private project data."
    >
      <TrustSection title="Open a support request">
        <p>
          <a className="trust-page__cta" href={GHOSTBUILD_SUPPORT_URL}>
            Create a GitHub support request
          </a>
        </p>
        <p>
          Public GitHub issues are visible to everyone. Remove personal data, prompts, source code, tokens, and
          Cloudflare account identifiers. Ghostbuild does not promise a response time during public beta.
        </p>
      </TrustSection>
      <TrustSection title="Account and privacy help">
        <p>
          For access, correction, portability, deletion, or account recovery, choose the Account and privacy category in
          the support form without posting private details. Ghostbuild may need a private follow-up path to verify
          control of the active Cloudflare identity before acting; that path is not currently guaranteed.
        </p>
      </TrustSection>
      <TrustSection title="Public beta channel limits">
        <p>{TRUST_CHANNEL_STATUS} Do not use a public issue for urgent or sensitive account requests.</p>
      </TrustSection>
    </TrustPage>
  );
}
