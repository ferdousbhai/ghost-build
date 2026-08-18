import { createFileRoute, Link } from '@tanstack/react-router';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import {
  GHOSTBUILD_SUPPORT_URL,
  TRUST_CHANNEL_STATUS,
  TRUST_PAGE_HEADINGS,
  createPublicBetaTrustPageHead,
} from '~/lib/trust';

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
      title={TRUST_PAGE_HEADINGS.support}
      summary="Use the public GitHub form for non-sensitive product, Ghostbuild sign-in, or privacy questions. Never include credentials, account details, or private project data."
    >
      <TrustSection title="Open a support request">
        <p>
          <a className="trust-page__cta" href={GHOSTBUILD_SUPPORT_URL}>
            Create a GitHub support request
          </a>
        </p>
        <p>
          Public GitHub issues are visible to everyone. Remove personal data, prompts, source code, tokens, and
          Cloudflare account identifiers. Ghostbuild aims to review and acknowledge a support request within two
          weekdays. This is a public-beta target, not a guarantee, contractual service level, or resolution deadline.
        </p>
      </TrustSection>
      <TrustSection title="Account and privacy requests">
        <p>
          Start with the public support form and include only the request type and your GitHub handle. If a private
          method can be arranged, a maintainer will identify it in the issue; until then, do not provide sensitive
          information. Ghostbuild does not yet provide a verified confidential support or privacy inbox, so never place
          identity documents, account details, or other private information in the issue. Applicable statutory deadlines
          govern privacy-rights requests regardless of the public-beta target above.
        </p>
      </TrustSection>
      <TrustSection title="Report abuse">
        <p>
          Abuse reports use the same public GitHub support form. There is no separate abuse address. Choose the abuse
          category, describe the prohibited use under the <Link to="/terms">Terms</Link>, and identify the affected
          Ghostbuild-generated site by its public URL only. Do not attach evidence containing personal data,
          credentials, or another person’s private content; a maintainer will ask for what is needed if a private method
          can be arranged.
        </p>
        <p>
          A vulnerability in Ghostbuild is not an abuse report. Use <Link to="/security">Security</Link> for that, so
          exploit details stay out of a public issue. Ghostbuild can act only on the service it operates: content and
          behaviour of a deployed application live in the Cloudflare account that owns it, so serious cases may also
          need <a href="https://developers.cloudflare.com/support/contacting-cloudflare-support/">Cloudflare support</a>{' '}
          or law enforcement.
        </p>
      </TrustSection>
      <TrustSection title="Availability and urgent situations">
        <p>{TRUST_CHANNEL_STATUS}</p>
        <p>
          Ghostbuild support is not an emergency service. For immediate danger, contact local emergency services. For a
          compromised Cloudflare account or an active Cloudflare platform incident, use{' '}
          <a href="https://developers.cloudflare.com/support/contacting-cloudflare-support/">Cloudflare support</a>. Use{' '}
          <Link to="/security">Security</Link> to report a vulnerability in Ghostbuild.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
