import { createFileRoute } from '@tanstack/react-router';
import { ClientTelemetryPreference } from '~/components/ClientRouteComponents';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import { GHOSTBUILD_OPERATOR_URL, createPublicBetaTrustPageHead } from '~/lib/trust';

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
      title="How Ghostbuild handles your data."
      summary="Ghostbuild operates a small control plane while project workspaces, builds, previews, and deployments run primarily in the Cloudflare account you connect."
    >
      <TrustSection title="Operator, scope, and roles">
        <p>
          Ghostbuild is operated by the owner of the <a href={GHOSTBUILD_OPERATOR_URL}>ferdousbhai GitHub account</a>.
          The operator controls Ghostbuild service processing, including account, project, conversation, support,
          security, and optional product-telemetry data. You separately control your connected Cloudflare account and
          are responsible for processing performed by applications you publish. Cloudflare and GitHub also process data
          under their own terms and privacy roles.
        </p>
      </TrustSection>

      <TrustSection title="Data, purposes, and legal bases">
        <ul>
          <li>
            <strong>Account and authentication:</strong> Cloudflare identity, name, email, avatar, session records,
            OAuth state, and connection status. These are used to authenticate you and provide the service you request,
            including steps taken before and during the service agreement. The identity and authorization fields are
            required to use signed-in features; without them, Ghostbuild cannot provide those features.
          </li>
          <li>
            <strong>Cloudflare connection:</strong> account identifiers, granted scopes, runtime locators, and encrypted
            credentials. These are used to operate the Cloudflare integration you authorize. Tokens, ciphertext, IVs,
            credential handles, and capability secrets are excluded from account-data responses.
          </li>
          <li>
            <strong>Projects and conversations:</strong> chat metadata, transcripts, generated files, revisions,
            validation receipts, deployment plans, approvals, and deployment status. These are processed to generate,
            recover, validate, and deploy your project under the service agreement. You choose what project content to
            provide, but Ghostbuild cannot perform a requested build without the content needed for that request.
          </li>
          <li>
            <strong>Security, support, and legal records:</strong> operational metadata and reports you submit. These
            are used for the operator’s legitimate interests in protecting users and infrastructure, answering requests,
            enforcing the Terms, and establishing or defending legal claims, or to meet a legal obligation.
          </li>
          <li>
            <strong>Optional product telemetry:</strong> allowlisted events, opaque journey or error-event identifiers,
            status values, and bounded numeric metrics. Consent is requested before Ghostbuild sends this telemetry.
            Prompts, source code, credentials, URLs, and direct user identifiers are excluded. The request omits browser
            credentials; a client IP supplied by Cloudflare is used transiently as a rate-limit key and is not included
            in the application event log.
          </li>
        </ul>
      </TrustSection>

      <TrustSection title="AI processing">
        <p>
          Prompts, conversation context, and project files needed for a request are sent to Cloudflare Workers AI to
          generate a response. Ghostbuild does not place prompt or source payloads in optional product telemetry and
          requests that AI Gateway not log request payloads. Cloudflare describes its handling of Workers AI content in
          its{' '}
          <a href="https://developers.cloudflare.com/workers-ai/platform/data-usage/">Workers AI data-usage notice</a>.
          Ghostbuild does not use AI to make decisions that produce legal or similarly significant effects about you.
        </p>
      </TrustSection>

      <TrustSection title="Browser storage and telemetry choice">
        <p>
          Essential browser storage includes a 30-day authentication cookie, short-lived OAuth and recovery state,
          account-local project replicas, theme preference, and a pending prompt in tab-scoped session storage. Project
          replicas and preferences remain until replaced or cleared in your browser. The retired prompt cookie is
          expired if found.
        </p>
        <p>
          Optional product telemetry is off until you allow it. Your choice is stored locally. Ghostbuild also honors
          Global Privacy Control and Do Not Track. Disabling telemetry stops future telemetry but does not remove events
          already received. You may withdraw telemetry consent at any time without affecting processing that occurred
          before withdrawal.
        </p>
        <ClientTelemetryPreference />
      </TrustSection>

      <TrustSection title="Where data is held and disclosed">
        <p>
          Ghostbuild control-plane records are held in Cloudflare D1. Workspace metadata, Agent transcripts, project
          files, Computer state, previews, and generated infrastructure are held primarily in the connected Cloudflare
          account. Data is disclosed only as needed to operate the service, follow your instructions, protect the
          service, or comply with law.
        </p>
        <p>
          Cloudflare provides authentication integration, Workers, D1, R2, Durable Objects, Containers, Computer,
          Workers AI, observability, and related infrastructure. GitHub processes information submitted through public
          support and abuse issues or private security reports. Ghostbuild does not sell personal data, share it for
          cross-context behavioral advertising, or use it for targeted advertising.
        </p>
      </TrustSection>

      <TrustSection title="International processing">
        <p>
          Cloudflare and GitHub operate globally, so data may be processed outside your country. Ghostbuild does not
          currently offer a selectable residency region. Cloudflare describes its transfer safeguards, including
          Standard Contractual Clauses where applicable, in its{' '}
          <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Data Processing Addendum</a>. Review{' '}
          <a href="https://www.cloudflare.com/policies/privacy/">Cloudflare’s Privacy Policy</a> and{' '}
          <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">
            GitHub’s privacy statement
          </a>
          , which describes GitHub’s international data-transfer practices.
        </p>
      </TrustSection>

      <TrustSection title="Retention, removal, and deletion">
        <p>
          Authentication sessions expire after 30 days. Expired authentication and OAuth records are removed by bounded
          maintenance, and unreferenced encrypted credential records are eligible for removal after 24 hours. Other
          control-plane, project, transcript, deployment, runtime, and observability records do not yet have a fixed
          deletion schedule. There is no self-service or account-wide export or deletion workflow during public beta;
          requests are assessed manually and available legal rights still apply.
        </p>
        <p>
          Removing a project hides it from the active project list and schedules its Agent and workspace for teardown no
          earlier than 30 minutes later. It is not complete erasure: catalog, transcript, deployment, observability,
          browser, and customer-controlled Cloudflare records remain unless removed through a separate applicable
          process. You can download individual project source before removal. Resources deployed to your Cloudflare
          account remain until you remove them there, and browser data remains until you clear it.
        </p>
        <p>
          GitHub retains public support and abuse issues and private security reports according to its policies and
          repository controls. Records may also need to remain for security, fraud prevention, legal compliance,
          disputes, or backups. A definitive retention and legal-hold schedule has not yet been adopted.
        </p>
      </TrustSection>

      <TrustSection title="Your choices and rights">
        <p>
          Depending on applicable law, you may request access, correction, portability, restriction, objection, or
          erasure and may complain to the data-protection authority responsible where you live or where an alleged
          infringement occurred. Start through <a href="/support">Support</a> with only the request type and your GitHub
          handle. The issue is public, so do not include account details, identity documents, personal data, or project
          content. If a private method can be arranged, a maintainer will identify it in the issue; until then, do not
          provide sensitive information. Ghostbuild does not yet provide a dedicated confidential privacy inbox.
        </p>
        <p>
          Ghostbuild may request proportionate information to verify control of the relevant Cloudflare identity before
          disclosing or deleting data. Public-beta response targets are not legal deadlines; where privacy law sets a
          deadline, including the GDPR’s usual one-month period, that deadline governs. Some rights and deletion
          requests are subject to lawful exceptions, and current technical limits are described above rather than
          treated as a waiver of those rights.
        </p>
      </TrustSection>

      <TrustSection title="Security and age limit">
        <p>
          Controls include encrypted Cloudflare credentials, hashed session and capability tokens, same-origin checks,
          short-lived runtime capabilities, tenant binding, bounded request sizes, deployment approval, and security
          readback. No system is risk-free. Ghostbuild is for adults and is not directed to anyone under 18; do not use
          the service if you are under 18.
        </p>
      </TrustSection>

      <TrustSection title="Changes and contact">
        <p>
          Material changes will be published with an updated version and effective date and, when practical, additional
          notice in the service. Use <a href="/support">Support</a> to start a privacy question without including
          sensitive details in the public issue.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
