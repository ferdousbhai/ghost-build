import { createFileRoute } from '@tanstack/react-router';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import { createPublicBetaTrustPageHead } from '~/lib/trust';

export const Route = createFileRoute('/terms')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Terms | Ghostbuild',
      description: 'Public-beta terms for using Ghostbuild and user-owned Cloudflare resources.',
      path: '/terms',
    }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <TrustPage
      eyebrow="Terms"
      title="You approve the build. You own the cloud bill."
      summary="Ghostbuild generates and operates project code inside the Cloudflare account you authorize. Production deployment always requires your explicit approval."
    >
      <TrustSection title="Service and account">
        <p>
          You must be able to form a binding agreement and must keep your Cloudflare account secure. You authorize
          Ghostbuild only for the scopes shown during connection. You remain responsible for activity, configuration,
          and charges in your Cloudflare account.
        </p>
      </TrustSection>
      <TrustSection title="Generated code and Cloudflare resources">
        <p>
          Generated code may contain mistakes, security issues, or unsuitable dependencies. Review, test, and monitor it
          before relying on it. You own or control the generated project and all Workers, D1 databases, R2 buckets,
          Containers, Durable Objects, Agents, and related resources deployed into your Cloudflare account, subject to
          Cloudflare’s terms and third-party licenses.
        </p>
        <p>
          Ghostbuild does not automatically enable Workers Paid. Cloudflare may charge your account for inference,
          storage, builds, network use, and deployed infrastructure. Deleting Ghostbuild-held account data does not
          delete resources in your Cloudflare account.
        </p>
      </TrustSection>
      <TrustSection title="Acceptable use">
        <p>
          Do not use Ghostbuild to violate law or third-party rights; distribute malware; gain unauthorized access;
          evade platform safeguards; expose secrets or personal data you lack authority to process; abuse Cloudflare or
          GitHub services; or generate deceptive, harassing, exploitative, or dangerous systems. We may limit access to
          protect users, the service, or external platforms.
        </p>
      </TrustSection>
      <TrustSection title="Beta and availability">
        <p>
          Ghostbuild is pre-release software provided on an as-available basis. The builder depends on Cloudflare
          services, including Cloudflare Computer 0.1.1, which Cloudflare publishes as a preview with an unstable API
          and does not designate for production use. Features may fail, change incompatibly, or become unavailable. No
          uptime or support service level is promised.
        </p>
      </TrustSection>
      <TrustSection title="Warranty and responsibility">
        <p>
          To the maximum extent permitted by law, Ghostbuild is provided without warranties, and the operator is not
          responsible for generated-code defects, lost data, Cloudflare charges, unavailable third-party services, or
          consequential losses. Mandatory consumer rights and liabilities that cannot lawfully be excluded remain
          unaffected. Ghostbuild does not yet publish service-specific governing-law, dispute, or liability-cap terms;
          this public-beta document has not been reviewed by qualified counsel.
        </p>
      </TrustSection>
      <TrustSection title="Changes and termination">
        <p>
          Material changes will be published with a new version and proposed effective date. You may stop using the
          service, revoke Cloudflare access, download individual project source, or contact{' '}
          <a href="/support">Support</a> about account data. Ghostbuild may suspend access for security, abuse, legal,
          or platform-integrity reasons.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
