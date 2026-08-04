import { createFileRoute } from '@tanstack/react-router';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import { GHOSTBUILD_ABUSE_URL, TRUST_CHANNEL_STATUS, createPublicBetaTrustPageHead } from '~/lib/trust';

export const Route = createFileRoute('/abuse')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Report abuse | Ghostbuild',
      description: 'Report harmful or prohibited use of Ghostbuild.',
      path: '/abuse',
    }),
  component: AbusePage,
});

function AbusePage() {
  return (
    <TrustPage
      eyebrow="Abuse reporting"
      title="Report harmful use without sharing secrets."
      summary="Abuse reports cover harmful content, impersonation, unauthorized automation, policy evasion, and misuse of a generated Ghostbuild application. Security vulnerabilities use a separate private channel."
    >
      <TrustSection title="File an abuse report">
        <p>
          <a className="trust-page__cta" href={GHOSTBUILD_ABUSE_URL}>
            Create a GitHub abuse report
          </a>
        </p>
        <p>
          The form is public. Do not post credentials, private personal data, exploit details, or confidential project
          content. Ghostbuild does not promise a response time during public beta.
        </p>
      </TrustSection>
      <TrustSection title="Cloudflare-hosted resources">
        <p>
          Deployed applications and resources are owned by the connected customer Cloudflare account. Ghostbuild can
          investigate its own control-plane activity, but it may not be able to remove or inspect customer-owned
          resources. You may also need to use Cloudflare’s abuse reporting process.
        </p>
      </TrustSection>
      <TrustSection title="Public beta channel limits">
        <p>{TRUST_CHANNEL_STATUS} Do not rely on this form for an emergency response.</p>
      </TrustSection>
    </TrustPage>
  );
}
