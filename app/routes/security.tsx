import { createFileRoute } from '@tanstack/react-router';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import { GHOSTBUILD_SECURITY_URL, TRUST_CHANNEL_STATUS, createPublicBetaTrustPageHead } from '~/lib/trust';

export const Route = createFileRoute('/security')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Security | Ghostbuild',
      description: 'Privately report a Ghostbuild vulnerability.',
      path: '/security',
    }),
  component: SecurityPage,
});

function SecurityPage() {
  return (
    <TrustPage
      eyebrow="Security"
      title="Keep vulnerability details private."
      summary="Use GitHub private vulnerability reporting for suspected vulnerabilities in Ghostbuild. Do not open a public support, abuse, or bug issue with exploit details."
    >
      <TrustSection title="Private reporting">
        <p>
          <a className="trust-page__cta" href={GHOSTBUILD_SECURITY_URL}>
            Report a vulnerability privately
          </a>
        </p>
        <p>
          Include the affected component, impact, reproduction steps or proof of concept, and a suggested mitigation if
          available. Remove credentials, personal data, and third-party secrets.
        </p>
      </TrustSection>
      <TrustSection title="Response and disclosure">
        <p>
          Ghostbuild does not promise a response time during public beta. If the owner responds, disclosure will be
          coordinated after an appropriate fix is available.
        </p>
      </TrustSection>
      <TrustSection title="Public beta channel limits">
        <p>{TRUST_CHANNEL_STATUS} Do not rely on this channel for an emergency response.</p>
      </TrustSection>
    </TrustPage>
  );
}
