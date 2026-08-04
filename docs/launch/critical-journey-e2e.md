# Critical-journey browser gate

`pnpm run validate:public-beta` is the safe, credential-free release preflight. It runs the complete repository
validation and then starts the built Worker with Vite preview to drive Chromium through hydrated home, signed-out
private routes, 404 handling, and desktop/mobile layout. That credential-free
gate retains failure screenshots, traces, video, and attached console/page/network diagnostics under `test-results/`
and `playwright-report/`. The authenticated journey disables those raw browser artifacts because they can contain live
cookies, prompts, generated code, preview URLs, and deployment identifiers; its release evidence is the redacted line
report and operator checklist. Install the required browser once with `pnpm run test:e2e:install`.

The authenticated journey is intentionally separate because it creates billable Cloudflare resources and has no safe
automatic cleanup contract. Never hide it inside a general validation command.

`pnpm run test:e2e:critical` is the authenticated launch journey. It intentionally fails rather than skips when these
isolated-staging inputs are absent:

- `E2E_BASE_URL`: a dedicated HTTPS staging candidate; the suite rejects `ghostbuild.dev`.
- `E2E_AUTH_STORAGE_STATE`: a Playwright storage-state file for the test user. Store an in-repository file only under
  ignored `playwright/.auth/`; never commit or upload it.
- `E2E_STAGING_ACCOUNT`: the exact 32-character Cloudflare account ID. The suite reads the authenticated connection and
  refuses to continue unless it matches.
- `E2E_CANDIDATE_SHA`: the exact lowercase 40-character release commit SHA. The suite reads `/api/version` and refuses
  to continue against any other deployment.
- Optional `E2E_BUILD_PROMPT`: a deterministic prompt maintained with the staging fixture.

Before prompting, the journey opens a runtime session. Ghostbuild automatically creates or reconciles the isolated
Computer runtime when needed, then verifies it before the build starts.

The candidate journey has a one-hour whole-test budget because validation, preview, and deployment each cross isolated
Cloudflare build/runtime boundaries. The deterministic built-browser smoke keeps the normal 60-second Playwright
budget. The authenticated journey runs once in desktop Chromium; the credential-free smoke alone covers desktop and
mobile, so a candidate invocation cannot create duplicate deployments through the project matrix.

The current spec covers prompt admission, streaming/tool completion, validation, editor mutation and save, revisioned
preview, explicit billing approval, deployment, and production URL reachability. A release operator must save its report
with the candidate version.

The following #91 requirements remain external launch blockers because the repository has no safe contract for them:

- deterministic provisioning and idempotent cleanup of staging Workers, D1, R2, Containers, tunnels, Agents, and test
  records;
- a second-user storage state and seeded project contract for open/mutate/preview/approve/deploy authorization checks;
- faithful Cloudflare failure doubles or staging fault injection for reconnect, preview, validation, and deployment
  recovery;
- a durable revision identifier exposed across editor save, preview, approved plan, and deployed artifact readback;
- CI artifact upload, flake-rate history, runtime-budget trend, and production-candidate smoke scheduling.

Do not claim the authenticated gate is launch-ready until those contracts exist and the suite passes against the
candidate. Do not add an authentication bypass or point cleanup logic at unresolved resource names to make the test
green.
