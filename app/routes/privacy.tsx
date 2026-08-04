import { createFileRoute } from '@tanstack/react-router';
import { ClientTelemetryPreference } from '~/components/ClientRouteComponents';
import { TrustPage, TrustSection } from '~/components/trust/TrustPage';
import { GHOSTBUILD_OPERATOR, createPublicBetaTrustPageHead } from '~/lib/trust';

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
      summary="Ghostbuild stores only narrow account and control-plane records. Server-side project and conversation data stays in the Cloudflare account you connect; your browser may keep an account-local replica."
    >
      <TrustSection title="Operator, scope, and roles">
        <p>
          {GHOSTBUILD_OPERATOR.legalName}, an {GHOSTBUILD_OPERATOR.legalForm} (Ontario Corporation No.{' '}
          {GHOSTBUILD_OPERATOR.registrationNumber}), operates Ghostbuild and is the controller for personal data
          Ghostbuild processes to operate the service. Its business correspondence address is{' '}
          {GHOSTBUILD_OPERATOR.correspondenceAddress}. This includes account, authentication, Cloudflare-connection,
          requested AI-building workflow, support, security, abuse, and optional product-telemetry processing.
          Persistent server-side project and conversation state remains in the connected Cloudflare account. You control
          that account and are responsible for processing performed by applications you publish. Cloudflare and GitHub
          also process data under their own terms and privacy roles.
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
            validation receipts, deployment plans, approvals, and deployment status. These are processed and stored in
            the connected Cloudflare account to generate, recover, validate, and deploy your project under the service
            agreement. The operator’s control-plane database does not store prompt or transcript bodies, project source,
            or deployment plans. You choose what project content to provide, but Ghostbuild cannot perform a requested
            build without the content needed for that request.
          </li>
          <li>
            <strong>Service and security logs:</strong> sampled Worker invocation, Container, and trace metadata can
            include request method and path, Cloudflare request metadata, response status, timing, binding activity, and
            exception or diagnostic metadata. The Ghostbuild control plane samples 60% of Worker logs and 5% of traces.
            In your connected Cloudflare account, the workspace runtime samples 60% of Worker logs and enables Computer
            container logs; generated applications sample 60% of Worker logs and 5% of traces. These settings support
            operation, troubleshooting, and security under the operator’s legitimate interests. Prompts, source code,
            credentials, and raw tool output are not intended log fields.
          </li>
          <li>
            <strong>Support, abuse, privacy, and legal records:</strong> contact details, message contents, attachments,
            case metadata, and reports you submit. These are used for the operator’s legitimate interests in answering
            requests, protecting users and infrastructure, enforcing the Terms, and establishing or defending legal
            claims, or to meet a legal obligation.
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
          The user-owned workspace runtime sends the prompt, conversation context, and project files needed for a
          request to the builder model you select through Cloudflare AI in the connected account. The selector
          distinguishes Cloudflare-hosted models from partner models. If you select DeepSeek V4 Pro, Cloudflare lists it
          as a{' '}
          <a href="https://developers.cloudflare.com/ai/models/deepseek/deepseek-v4-pro/">
            third-party model served by Fireworks
          </a>
          , so Fireworks also processes the request content needed for inference. Ghostbuild does not place prompt or
          source payloads in optional product telemetry. For these calls, Ghostbuild disables AI Gateway request logging
          at the gateway, model-request, and request-header layers, so it does not use AI Gateway to retain request
          payloads or request metadata. This does not change the transient processing needed for inference. Cloudflare
          describes its handling of Workers AI content in its{' '}
          <a href="https://developers.cloudflare.com/workers-ai/platform/data-usage/">Workers AI data-usage notice</a>.
          Ghostbuild does not use AI to make decisions that produce legal or similarly significant effects about you.
        </p>
      </TrustSection>

      <TrustSection title="Browser storage and telemetry choice">
        <p>
          Essential browser storage includes a 30-day authentication cookie, short-lived OAuth and recovery state,
          account-local project replicas, theme and builder-model preferences, and a pending prompt in tab-scoped
          session storage. Project replicas and preferences remain until replaced or cleared in your browser. The
          retired prompt cookie is expired if found.
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
          The operator’s Cloudflare D1 stores account, authentication, encrypted Cloudflare-connection, and runtime
          locator records. It does not store prompts, chat transcripts, project source, deployment plans, or generated
          application data. Workspace metadata, Agent transcripts, project files, Computer state, previews, and
          generated infrastructure remain in the connected Cloudflare account. Your browser may keep account-local
          transcript and project-file replicas. Data is disclosed only as needed to operate the service, follow your
          instructions, protect the service, or comply with law.
        </p>
        <p>
          Cloudflare provides authentication integration, Workers, D1, R2, Durable Objects, Containers, Computer,
          Workers AI, the Cloudflare AI model catalog, observability, and related infrastructure. A model provider
          listed in the selector also processes the request when you choose its partner-hosted model. GitHub processes
          information submitted through public support and abuse issues or private security reports. Control-plane
          observability is held in the operator’s Cloudflare account; workspace, Computer, and generated-application
          observability is held in your connected Cloudflare account. Ghostbuild does not sell personal data, share it
          for cross-context behavioral advertising, or use it for targeted advertising.
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
          In the operator control plane, OAuth authorization state expires after 10 minutes, authentication sessions
          after 30 days, and unreferenced encrypted credential records become eligible for removal after 24 hours.
          Maintenance runs every 15 minutes in bounded batches, so backlog or retries can delay physical removal.
          Account, connection, and runtime-locator records remain while the account and service are active or until they
          are no longer needed or a verified request is fulfilled. There is no automatic inactive-account purge or
          self-service export or deletion during public beta; requests are assessed manually and available legal rights
          still apply.
        </p>
        <p>
          Project, transcript, deployment, Agent, and workspace records remain in the connected Cloudflare account under
          that account’s controls. Ghostbuild provides project-level download and removal, but no single action erases
          operator records, user-owned Cloudflare state, and browser replicas together. You can revoke Ghostbuild’s
          authorization, manage or remove Cloudflare resources in your account, and clear Ghostbuild site data in each
          browser you use.
        </p>
        <p>
          The operator’s current Cloudflare plan retains sampled control-plane Workers Logs and traces for seven days.
          Ghostbuild does not copy them to another log or trace store, and access is currently limited to the sole
          operator-account administrator. Cloudflare may retain aggregate control-plane Worker metrics for up to three
          months; those metrics are not a user-addressable event ledger.
        </p>
        <p>
          Workspace Worker and Computer container logs, and generated-application Worker logs and traces, remain in your
          connected Cloudflare account. Their access and retention follow that account’s permissions, plan, product
          settings, and Cloudflare controls. Ghostbuild does not copy them into the operator’s log or trace store, and
          removing a project does not immediately erase provider-retained observability.
        </p>
        <p>
          <a href="https://developers.cloudflare.com/d1/reference/time-travel/">Cloudflare D1 Time Travel</a> keeps
          control-plane database changes recoverable for up to 30 days under the current plan. User-owned D1 recovery
          windows depend on the user’s Cloudflare plan. Ghostbuild will not intentionally restore erased records from
          recovery history. If broader disaster recovery reintroduces them, the erasure must be reapplied unless a
          lawful retention exception governs.
        </p>
        <p>
          Removing a project hides it from the active project list and makes its Agent and workspace eligible for
          teardown no earlier than 30 minutes later; cleanup can be delayed and retried. It is not complete erasure:
          catalog, transcript, deployment, observability, browser, and customer-controlled Cloudflare records remain
          unless removed through a separate applicable process. You can download individual project source before
          removal. Resources deployed to your Cloudflare account remain until you remove them there, and browser data
          remains until you clear it.
        </p>
        <p>
          GitHub retains public support and abuse issues and private security reports according to its policies and
          repository controls. Records may also need to remain for security, fraud prevention, legal compliance,
          disputes, or backups.
        </p>
      </TrustSection>

      <TrustSection title="Your choices and rights">
        <p>
          Depending on applicable law, you may request access, correction, portability, restriction, objection, or
          erasure and may complain to the data-protection authority responsible where you live or where an alleged
          infringement occurred. Start with the public <a href="/support">Support</a> form and include only the request
          type and your GitHub handle. If a private method can be arranged, a maintainer will identify it in the issue;
          until then, do not provide sensitive information. Ghostbuild does not yet provide a verified confidential
          privacy inbox.
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
          notice in the service. Use <a href="/support">Support</a> for privacy questions, sharing only the request type
          and your GitHub handle in the public form.
        </p>
      </TrustSection>
    </TrustPage>
  );
}
