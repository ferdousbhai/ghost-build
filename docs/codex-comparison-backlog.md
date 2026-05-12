# Codex Comparison Backlog

This backlog tracks improvement opportunities found by comparing GhostBuild
with the open-source OpenAI Codex codebase. Each entry is scoped like a GitHub
issue so it can be copied into the tracker.

## Implementation Status

Completed in this branch:

- Real typed auth state is represented in `src/lib/model-auth.ts` and exposed to
  the builder through `/api/codex-auth/status`.
- ChatGPT/Codex OAuth PKCE start, callback, status, and logout routes live under
  `src/routes/api/codex-auth/`; token material is encrypted in HttpOnly cookies
  and never stored in localStorage.
- Model auth resolution is explicit in `src/lib/model-auth.ts`; the first
  product iteration supports only ChatGPT/Codex OAuth.
- ChatGPT account metadata parsing and missing-metadata handling are implemented
  in `src/lib/codex-oauth.ts` and surfaced in the builder UI.
- API-key fallback and Google app sign-in were removed to keep onboarding simple
  for ChatGPT subscribers.
- Permission presets and confirmation validation are implemented in
  `src/lib/permissions.ts`.
- Deploy approval records are created through `/api/deploy/approval`, include
  target account, Worker name, bindings, estimated cost, paid/destructive flags,
  and are validated against the planned Worker before deploy actions can proceed.
- Runtime Cloudflare action gating is centralized in
  `src/lib/runtime-action-executor.ts` for deploy, paid, and destructive action
  enforcement.
- Authenticated builder session snapshots can be saved and listed through
  `/api/builder-sessions`, scoped by Codex account metadata and persisted in an
  owner-scoped GhostBuild Durable Object.
- Cloudflare connection readiness is checked through `/api/cloudflare/status`;
  users can connect their own Cloudflare API token through
  `/api/cloudflare/connect`, stored encrypted in an HttpOnly cookie.
- Goal state is part of the plan and run prompt; the builder lets users edit
  the active goal and success criteria before and after a run starts.
- Goal edits after a run starts are added to the chat timeline with before/after
  text.
- Goal status can now be evaluated from run evidence as active, blocked, or
  completed.
- Authenticated Worker app artifact generation is available through
  `/api/build/generate`, and generated files are saved in the session snapshot.
- Generated Worker artifacts can be validated through `/api/build/checks`, and
  deploy progress stays blocked until checks pass.
- Checked Worker artifacts can prepare a persisted preview URL through
  `/api/build/preview`; deploy progress stays blocked until preview is ready.
- The preview panel now renders execution progress from a typed build-stage
  model instead of static plan-phase copy.
- Existing-project import UI is disabled until real repository/archive intake is
  implemented.
- The UI now includes explicit "Goal-driven Cloudflare web app builder"
  positioning and a Cloudflare stack readiness strip.
- Model policy is catalog-backed in `src/lib/model-catalog.ts`, and reasoning UI
  choices are derived from catalog metadata.
- Agent run streams use typed completion, error, status, transcript, tool, and
  approval event shapes via `src/lib/agent-stream.ts`.
- Builder plans now include session and project ids, Durable Object lookup uses
  session id, and non-secret session state is persisted for return visits.
- README and AGENTS document the implemented model/auth defaults and billing
  boundaries.

Still outstanding before this is a true end-to-end product:

- Replace deterministic Worker app artifact generation/checking/preview URLs
  with agent-authored generation, repair, live previews, and deploy execution.
- Add real GitHub/archive/folder intake before re-enabling existing-project
  import.
- Add browser-level end-to-end tests for OAuth redirects and Cloudflare
  readiness against a running app.

Verified with:

- `pnpm test`
- `pnpm build`

Current test coverage includes Codex OAuth start, callback validation, logout,
malformed and expired token cookies, deploy approval enforcement, runtime action
gating, Cloudflare status parsing, encrypted Cloudflare token cookies, goal
status evaluation, Worker artifact generation, paid/destructive approval
details, generated artifact checks, and builder UI gates for goal editing,
Cloudflare connect, deploy confirmation, auth-disabled submit, and disabled
import. Preview URL preparation is covered by unit and UI tests.

## 1. Replace Placeholder Codex Auth With Real Auth State

Status: complete.

GhostBuild currently represents ChatGPT/Codex auth as a local browser boolean.
Codex models auth as ChatGPT OAuth, externally managed ChatGPT tokens, and agent
identity. GhostBuild's first iteration intentionally supports only
ChatGPT/Codex OAuth.

Scope:
- Replace the `localCodexAuth` boolean with a typed auth state.
- Track disconnected, connecting, connected, expired, refresh failed, and
  unsupported states.
- Keep ChatGPT/Codex auth server-confirmed.
- Expose auth state to the builder UI without exposing tokens.

Acceptance:
- The UI cannot mark Codex auth connected without server-confirmed credentials.
- ChatGPT/Codex mode is represented by server-confirmed state.
- Failed or expired Codex auth has a visible recovery path.

## 2. Add ChatGPT/Codex OAuth PKCE Flow

Status: complete.

Codex uses PKCE, state validation, a localhost callback, token exchange, and
stored ChatGPT account metadata. GhostBuild needs an equivalent Worker-safe
OAuth flow.

Scope:
- Add OAuth start and callback routes.
- Generate and verify PKCE verifier/challenge and state.
- Exchange the authorization code for tokens.
- Store token material securely server-side.
- Support logout and token revocation where available.

Acceptance:
- Users can sign in with ChatGPT/Codex from the GhostBuild UI.
- OAuth state and PKCE verifier are validated before token exchange.
- Tokens are never stored in browser localStorage.
- Logout removes stored credentials.

## 3. Introduce A Model Auth Provider Layer

Status: complete.

Codex resolves request credentials through a provider abstraction. GhostBuild
previously passed transient model credentials directly into the Durable Object.

Scope:
- Add a small model auth provider interface for ChatGPT/Codex auth.
- Resolve runtime auth before each agent turn.
- Attach auth metadata without adding secrets to prompts or plans.
- Keep auth selection independent from model selection and reasoning effort.

Acceptance:
- `model` and `reasoningEffort` remain separate request fields.
- No agent turn can silently change auth mode.
- Codex OAuth requests use the provider path.

## 4. Surface ChatGPT Account And Plan Metadata

Status: complete.

Codex parses ChatGPT plan, email, user id, account id, and FedRAMP routing data
from auth tokens.

Scope:
- Parse account metadata from the ChatGPT/Codex OAuth response.
- Store non-secret metadata for UI and audit.
- Show signed-in account, plan type, and workspace/account state.
- Handle unknown or missing plan metadata explicitly.

Acceptance:
- The UI can show which ChatGPT account is selected.
- Plan type is visible when available.
- Missing account metadata does not masquerade as a valid connected state.

## 5. Prevent Silent Billing Fallback

Status: complete.

Codex keeps auth mode explicit. GhostBuild should never fall back from
ChatGPT/Codex allowance to another billing path.

Scope:
- Remove the API-key fallback path.
- Preserve the no-silent-fallback guard by having only one model auth path.
- Make billing/auth mode visible in every run summary.

Acceptance:
- Codex mode never sends user-supplied model secrets.
- There is no API-key mode in the first iteration.
- Tests cover required Codex OAuth credentials.

## 6. Add Permission And Approval Presets

Status: complete.

Codex has reusable approval presets for read-only, workspace-write, and
full-access behavior. GhostBuild needs structured permission profiles for
Cloudflare and project actions.

Scope:
- Define permission presets for planning, code changes, preview, deploy, paid
  Cloudflare actions, destructive Cloudflare actions, and GitHub writes.
- Require confirmation for paid and destructive actions.
- Store confirmation records without sensitive payment data.
- Surface requested action, resource, risk, and estimated cost when known.

Acceptance:
- Paid/destructive actions cannot execute without a matching confirmation.
- Confirmations are auditable.
- Non-destructive planning can continue without Cloudflare payment setup.

## 7. Add A Model Catalog

Status: complete.

Codex uses model metadata for default reasoning effort, supported efforts,
modalities, service tiers, and API availability. GhostBuild currently hardcodes
`gpt-5.5` and a small reasoning union.

Scope:
- Add a static model catalog as the first step.
- Include model id, display name, supported auth modes, default reasoning
  effort, supported reasoning efforts, and availability notes.
- Render the selected model and allowed reasoning choices from metadata.

Acceptance:
- UI options are derived from catalog metadata.
- Unsupported reasoning effort cannot be selected for a model.
- Tests verify default model policy is catalog-backed.

## 8. Make Agent Stream Events Typed And Loss-Aware

Status: complete.

Codex classifies terminal and transcript events as lossless under backpressure.
GhostBuild currently uses simple SSE status/chunk/done events.

Scope:
- Define typed agent run events for status, transcript delta, tool event,
  approval request, error, and completion.
- Ensure terminal events are always delivered.
- Add parsing error handling for malformed SSE payloads.
- Keep recoverable status updates separate from authoritative completion.

Acceptance:
- The client cannot hang forever after a server-side completion.
- Malformed event payloads surface a readable error.
- Completion and error events are covered by tests.

## 9. Add Durable Builder Sessions And Project Identity

Status: complete.

Codex treats threads, turns, and sessions as first-class concepts. GhostBuild
currently keys the Durable Object from a generated worker slug.

Scope:
- Add explicit builder session ids.
- Add project ids for new and imported projects.
- Persist selected source, model policy, and run status by session.
- Decouple worker deployment slug from chat/session identity.

Acceptance:
- Two sessions with the same app idea cannot collide on Durable Object identity.
- A user can return to a previous builder session.
- Deployment naming remains editable independently from session id.

## 10. Update Product Documentation

Status: complete.

The current README and project notes should describe ChatGPT/Codex OAuth as the
only model access path for the first iteration.

Scope:
- Document `gpt-5.5` as the model.
- Document ChatGPT/Codex OAuth as the auth mode.
- Document that there is no API-key fallback in the first iteration.
- Document low reasoning as the default reasoning effort.

Acceptance:
- README and AGENTS agree with the implemented request model.
- Documentation does not imply ChatGPT subscriptions pay for generic OpenAI API
  calls.
