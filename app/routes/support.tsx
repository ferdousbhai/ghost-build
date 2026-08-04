import { createFileRoute } from '@tanstack/react-router';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import { GHOSTBUILD_SUPPORT_URL, TRUST_CHANNEL_STATUS, createLaunchCandidateTrustPageHead } from '~/lib/trust';

export const Route = createFileRoute('/support')({
  head: () =>
    createLaunchCandidateTrustPageHead({
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
          Proposed launch target, not a service-level agreement: acknowledge support and account-help requests within
          three business days. Public GitHub issues are visible to everyone; remove personal data, prompts, source code,
          tokens, and Cloudflare account identifiers.
        </p>
      </TrustSection>
      <TrustSection title="Account and privacy help">
        <p>
          For access, correction, portability, deletion, or account recovery, choose the Account and privacy category in
          the support form. Ghostbuild may need to verify control of the active Cloudflare identity before acting.
        </p>
      </TrustSection>
      <TrustSection title="Launch blocker">
        <p>
          <strong>Monitored-channel confirmation is pending.</strong> {TRUST_CHANNEL_STATUS} Response targets and
          escalation ownership must be approved before launch.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
