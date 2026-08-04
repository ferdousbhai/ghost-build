import { createFileRoute } from '@tanstack/react-router';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import { createPublicBetaTrustPageHead } from '~/lib/trust';

export const Route = createFileRoute('/privacy')({
  head: () =>
    createPublicBetaTrustPageHead({
      title: 'Privacy | Ghostbuild',
      description: 'How Ghostbuild handles account, workspace, deployment, and product data.',
      path: '/privacy',
    }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <TrustPage
      eyebrow="Privacy"
      title="Your project lives in your Cloudflare account."
      summary="Ghostbuild operates a small control plane while project workspaces, builds, previews, and deployments run in the Cloudflare account you connect."
    >
      <TrustSection title="Data we process and why">
        <ul>
          <li>
            <strong>Account and authentication:</strong> Cloudflare identity, name, email, avatar, session records,
            OAuth state, and connection status, used to authenticate you and bind requests to your account.
          </li>
          <li>
            <strong>Cloudflare connection:</strong> account identifiers, granted scopes, runtime locators, and encrypted
            credentials, used to reach the runtime you authorize. Tokens, ciphertext, IVs, credential handles, and
            capability secrets are never included in account-data responses.
          </li>
          <li>
            <strong>Projects and conversations:</strong> chat metadata, transcripts, generated project files, revisions,
            validation receipts, deployment plans, approvals, and deployment status, used to provide the builder and
            recovery features.
          </li>
          <li>
            <strong>Product operations:</strong> allowlisted events, opaque journey or error-event identifiers, status
            values, and bounded numeric metrics, used to operate and protect the service. Prompts, source code,
            credentials, URLs, and direct user identifiers are excluded from product telemetry. The telemetry request
            omits browser credentials; Cloudflare supplies a client IP that the application uses transiently only as the
            rate-limit key and does not include in the application event log.
          </li>
          <li>
            <strong>Browser data:</strong> account-local replicas, theme preference, a pending prompt in tab-scoped
            session storage, and short-lived recovery state, used for editing, continuity, and interface preferences on
            your device. The message input expires the retired prompt cookie if it is present.
          </li>
        </ul>
      </TrustSection>

      <TrustSection title="Where data is held">
        <p>
          Ghostbuild control-plane records are held in Cloudflare D1. User workspace metadata, Agent transcripts,
          project files, Computer state, previews, and generated infrastructure are held in the connected user
          Cloudflare account. Cloudflare operates a global network and may process data in locations described by its
          privacy and data-transfer terms; Ghostbuild does not currently offer a selectable residency region.
        </p>
      </TrustSection>

      <TrustSection title="Processors and external services">
        <p>
          Cloudflare provides authentication integration, Workers, D1, R2, Durable Objects, Containers, Computer,
          Workers AI, observability, and related infrastructure. GitHub processes information you choose to submit
          through public support or abuse issues and private vulnerability reports. Review{' '}
          <a href="https://www.cloudflare.com/policies/privacy/">Cloudflare’s Privacy Policy</a>, its{' '}
          <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Data Processing Addendum</a>, and{' '}
          <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">
            GitHub’s privacy statement
          </a>
          .
        </p>
      </TrustSection>

      <TrustSection title="Retention and deletion">
        <p>
          Authentication sessions expire after 30 days. Expired authentication and OAuth records are removed by bounded
          maintenance, and unreferenced encrypted credential records are eligible for removal after 24 hours. A deleted
          project enters a bounded cleanup workflow after a 30-minute recovery grace period. Other account and runtime
          records remain while the account or project exists or until a supported deletion request is completed.
        </p>
        <p>
          Self-service account export and deletion are not available. Use <a href="/support">Support</a> to request
          access to or deletion of reachable Ghostbuild-held account data. Generated Workers, D1 databases, R2 buckets,
          Containers, Durable Objects, browser storage, and other resources in your Cloudflare account or browser remain
          your responsibility to download, remove, or clear.
        </p>
        <p>
          Public-beta requests are handled manually without a promised response time. Do not put sensitive information
          in the public issue; a request may not be actionable until a private identity-verification path is arranged.
        </p>
        <p>
          Retention may be extended when applicable law requires it. Material changes to the current retention approach
          will be documented here.
        </p>
      </TrustSection>

      <TrustSection title="Security">
        <p>
          Controls include encrypted Cloudflare credentials, hashed session and capability tokens, same-origin checks
          for state-changing control-plane requests, short-lived runtime capabilities, tenant binding, bounded request
          and response sizes, deployment approval, and security readback before deployment. No system is risk-free.
        </p>
      </TrustSection>

      <TrustSection title="Your choices and rights">
        <p>
          You can download individual project source, delete projects, disconnect by revoking Cloudflare authorization,
          and clear Ghostbuild site data in your browser. Depending on applicable law, you may also request access,
          correction, portability, restriction, objection, or erasure and complain to a supervisory authority. Use{' '}
          <a href="/support">Support</a> for account and privacy requests.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
