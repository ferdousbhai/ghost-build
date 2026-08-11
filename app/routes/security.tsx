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
      summary="Use GitHub private vulnerability reporting for suspected vulnerabilities in Ghostbuild. Do not open a public support or bug issue with exploit details."
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
          Ghostbuild aims to review and acknowledge a private security report within one weekday and provide an initial
          triage update within three weekdays. These are public-beta targets, not guarantees, contractual service
          levels, or a promise that a fix will be available by a particular date. Public disclosure should be
          coordinated after affected users can be protected and an appropriate fix is available.
        </p>
      </TrustSection>
      <TrustSection title="Research boundaries">
        <p>
          This policy covers Ghostbuild’s code repository and the service at ghostbuild.dev. It does not authorize
          testing Cloudflare, GitHub, customer-controlled deployments, or other third-party systems. Test only accounts
          and resources you control. Do not access, retain, or alter another person’s data; disrupt service; use social
          engineering; or create avoidable privacy, safety, or financial harm. Stop and report if you encounter
          sensitive data. Ghostbuild cannot bind third parties or law enforcement.
        </p>
      </TrustSection>
      <TrustSection title="Availability and emergencies">
        <p>{TRUST_CHANNEL_STATUS}</p>
        <p>
          Do not rely on this channel for immediate incident containment. Revoke exposed credentials and Ghostbuild’s
          Cloudflare authorization first, use{' '}
          <a href="https://developers.cloudflare.com/support/contacting-cloudflare-support/">Cloudflare support</a> for
          a compromised Cloudflare account, and contact local emergency services for immediate danger.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
