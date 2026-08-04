import { createFileRoute } from '@tanstack/react-router';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import {
  CLOUDFLARE_ABUSE_URL,
  GHOSTBUILD_ABUSE_URL,
  TRUST_CHANNEL_STATUS,
  createPublicBetaTrustPageHead,
} from '~/lib/trust';

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
      title="Report harmful use through the right channel."
      summary="Abuse reports cover harmful content, impersonation, unauthorized automation, policy evasion, and misuse of a generated Ghostbuild application. Sensitive evidence and security vulnerabilities must stay private."
    >
      <TrustSection title="File an abuse report">
        <p>
          <a className="trust-page__cta" href={GHOSTBUILD_ABUSE_URL}>
            Create a GitHub abuse report
          </a>
        </p>
        <p>
          The form is public. Do not post credentials, private personal data, exploit details, or confidential project
          content. Use it only when the location and concern can be described safely with public information.
        </p>
      </TrustSection>
      <TrustSection title="Sensitive or illegal content">
        <p>
          Ghostbuild does not yet provide a dedicated confidential abuse inbox. If a concern cannot be described safely
          in public, do not put the evidence in a GitHub issue. For a security vulnerability, use the{' '}
          <a href="/security">private security channel</a>. For live Cloudflare-hosted abuse, use{' '}
          <a href={CLOUDFLARE_ABUSE_URL}>Cloudflare’s abuse form</a>, which accepts non-public report details.
        </p>
        <p>
          Do not download, copy, or attach suspected child sexual abuse material or other illegal imagery. Provide the
          public location through Cloudflare’s official form and contact the appropriate local authority.
        </p>
      </TrustSection>
      <TrustSection title="Cloudflare-hosted resources">
        <p>
          Deployed applications and resources are created in and controlled through the connected customer Cloudflare
          account. Ghostbuild can investigate its own control-plane activity, but it may not be able to remove or
          inspect customer-controlled resources. For phishing, malware, intellectual-property concerns, or other live
          abuse on a Cloudflare-hosted resource, also use{' '}
          <a href={CLOUDFLARE_ABUSE_URL}>Cloudflare’s abuse reporting process</a>.
        </p>
      </TrustSection>
      <TrustSection title="Response targets and emergencies">
        <p>{TRUST_CHANNEL_STATUS}</p>
        <p>
          For immediate danger, contact local emergency services or law enforcement. Do not wait for Ghostbuild or
          GitHub to respond. Acknowledgement does not guarantee removal: Ghostbuild may need to preserve evidence,
          verify the report, refer it to Cloudflare or the customer account owner, or follow applicable legal process.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
