import { createFileRoute } from '@tanstack/react-router';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import { createPublicBetaTrustPageHead } from '~/lib/trust';

export const Route = createFileRoute('/terms')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Terms | Ghostbuild',
      description: 'Public-beta terms for using Ghostbuild and customer-controlled Cloudflare resources.',
      path: '/terms',
    }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <TrustPage
      eyebrow="Terms"
      title="You approve the build. You control the cloud account."
      summary="These terms govern the Ghostbuild public beta. The service can generate and operate project code inside the Cloudflare account you authorize, and production deployment requires your explicit approval."
    >
      <TrustSection title="Operator, acceptance, and eligibility">
        <p>
          Ghostbuild is operated by the owner of the{' '}
          <a href="https://github.com/ferdousbhai">ferdousbhai GitHub account</a>, which maintains the{' '}
          <a href="https://github.com/ferdousbhai/ghost-build">Ghostbuild repository</a>. These Terms form an agreement
          between you and the operator. By connecting Cloudflare or using the signed-in service, you agree to these
          Terms. You must be at least 18, able to form a binding agreement, and authorized to act for any organization
          or Cloudflare account you use.
        </p>
      </TrustSection>
      <TrustSection title="Public-beta service and account access">
        <p>
          Ghostbuild is currently a free public beta. It uses AI and preview Cloudflare technology to generate,
          validate, preview, and deploy applications. You authorize only the Cloudflare scopes shown during connection
          and must keep your Ghostbuild and Cloudflare access secure. Cloudflare may separately charge your account for
          inference, storage, builds, network use, and deployed infrastructure. Ghostbuild does not automatically enable
          Workers Paid.
        </p>
      </TrustSection>
      <TrustSection title="Your inputs and generated output">
        <p>
          You keep your rights in prompts, files, and other material you provide. You give Ghostbuild a limited license
          to host, copy, transmit, and transform that material only as needed to provide, secure, troubleshoot, and
          maintain the service. You must have the rights and permissions needed to provide it.
        </p>
        <p>
          As between you and Ghostbuild, Ghostbuild claims no ownership in generated project output. AI output may not
          be unique or legally protectable and may be affected by third-party rights, open-source licenses, and service
          terms. Similar output may be generated for others.
        </p>
      </TrustSection>
      <TrustSection title="Generated applications and Cloudflare resources">
        <p>
          Generated code may contain mistakes, security issues, or unsuitable dependencies. Review, test, and monitor it
          before relying on it. Workers, D1 databases, R2 buckets, Containers, Durable Objects, Agents, and related
          resources are created in, controlled through, and billed to your Cloudflare account, subject to Cloudflare’s
          terms and third-party licenses.
        </p>
        <p>
          You are responsible for the applications you publish, including their content, users, security, monitoring,
          legal notices, data handling, and compliance. Removing a project or Ghostbuild-held account data does not
          remove resources from your Cloudflare account.
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
          Ghostbuild is pre-release software provided on an as-available basis. It depends on Cloudflare and other
          third-party services, including preview technology with changing interfaces. Features may fail, change
          incompatibly, lose data, or become unavailable. No uptime, support, or emergency-response service level is
          promised.
        </p>
      </TrustSection>
      <TrustSection title="Suspension, termination, and data">
        <p>
          You may stop using Ghostbuild at any time and revoke its Cloudflare access. Ghostbuild may limit or suspend
          access when reasonably necessary for security, abuse prevention, legal compliance, service integrity, or a
          material breach of these Terms. Notice will be provided when reasonably practical. Removal from Ghostbuild
          does not remove customer-controlled Cloudflare resources, and the retention boundaries in the{' '}
          <a href="/privacy">Privacy notice</a> continue to apply.
        </p>
      </TrustSection>
      <TrustSection title="Warranty and liability">
        <p>
          To the maximum extent permitted by law, Ghostbuild is provided “as is” and “as available,” without implied
          warranties of merchantability, fitness for a particular purpose, non-infringement, or uninterrupted operation.
          You are responsible for reviewing generated code, maintaining backups, and controlling spending in your
          Cloudflare account.
        </p>
        <p>
          If you use Ghostbuild mainly for a trade, business, craft, or profession, then to the maximum extent permitted
          by law the operator will not be liable for indirect, incidental, special, consequential, exemplary, or
          punitive damages, or for lost profits, revenue, data, goodwill, or business interruption. For those business
          users, the operator’s aggregate liability arising from the service will not exceed the greater of US$100 and
          the amount paid directly to Ghostbuild during the 12 months before the event giving rise to the claim.
        </p>
        <p>
          If you use Ghostbuild as a consumer, your remedies and the operator’s liability are governed by the mandatory
          law that applies to you. The business-user exclusions and cap above do not replace those rights. Nothing in
          these Terms excludes liability for fraud, wilful misconduct, or any other liability that cannot lawfully be
          excluded or limited.
        </p>
      </TrustSection>
      <TrustSection title="Applicable law and disputes">
        <p>
          These Terms do not take away mandatory rights available where you live. Applicable law and courts are
          determined by the conflict-of-law and jurisdiction rules that govern you and the operator. You may use{' '}
          <a href="/support">Support</a> to try to resolve a concern before filing a claim, but doing so is not a
          condition on any remedy or urgent relief available under applicable law.
        </p>
      </TrustSection>
      <TrustSection title="Changes, notices, and general terms">
        <p>
          Changes apply prospectively. When reasonably practical, material changes will be published on this page with
          an updated version, effective date, and advance notice before they take effect. Urgent changes needed for
          security, safety, legal compliance, or third-party platform requirements may take effect sooner. You may stop
          using Ghostbuild and revoke its Cloudflare authorization before a later effective date. Continued signed-in
          use after that date accepts the updated Terms where applicable law permits. If any provision is unenforceable,
          the rest remains effective, and a failure to enforce a provision is not a waiver. Use{' '}
          <a href="/support">Support</a> for notices or questions.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
