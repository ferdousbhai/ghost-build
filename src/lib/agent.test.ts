import { describe, expect, it, vi } from 'vitest'
import { buildAgentPlan, evaluateGoalStatus } from './agent'
import {
  encodeAgentRunEvent,
  parseAgentRunEvent,
  isTerminalAgentRunEvent,
} from './agent-stream'
import { createBuilderSession } from './builder-session'
import { buildExecutionProgress } from './build-execution'
import { runGeneratedWorkerChecks } from './build-checks'
import { runGeneratedWorkerBuildPipeline } from './build-pipeline'
import { runGeneratedWorkerBuildDeployPipeline } from './build-deploy-pipeline'
import { createBuildPreviewResult } from './build-preview'
import { repairGeneratedWorkerApp } from './build-repair'
import { deployGeneratedWorkerApp } from './cloudflare-deploy'
import {
  getBuilderSessionSnapshot,
  listBuilderSessionSnapshots,
  ownerIdFromCodexAccount,
  summarizeBuilderSessionSnapshot,
  upsertBuilderSessionSnapshot,
} from './builder-session-store'
import { verifyCloudflareConnection } from './cloudflare-status'
import {
  cloudflareTokenCookie,
  readCloudflareTokenFromRequest,
  sealCloudflareTokenCookieValue,
} from './cloudflare-auth'
import {
  codexOAuthStateCookie,
  codexOAuthAccountCookie,
  codexOAuthTokenCookie,
  codexOAuthVerifierCookie,
  createCodexLogout,
  createOAuthStart,
  exchangeOAuthCallback,
  readCodexTokenFromRequest,
  sealCodexTokenCookieValue,
} from './codex-oauth'
import {
  assertDeployActionAllowed,
  createDeployApprovalRecord,
} from './deploy-approval'
import {
  resolveModelRuntimeAuth,
  summarizeCodexAuthState,
} from './model-auth'
import { defaultModel, normalizeReasoningEffort } from './model-catalog'
import { assertActionAllowed, type ApprovalConfirmation } from './permissions'
import { assertRuntimeActionAllowed } from './runtime-action-executor'
import { generateWorkerAppFromPlan } from './generated-worker-app'
import { proposeAndApplyGeneratedWorkerPatches } from './generated-worker-agent-patch'
import { applyGeneratedWorkerPatches } from './generated-worker-patch'
import { handleCodexOAuthCallback } from '../routes/api/codex-auth/callback'
import { handleCodexOAuthLogout } from '../routes/api/codex-auth/logout'
import { handleCodexOAuthStart } from '../routes/api/codex-auth/start'
import { handleCodexOAuthStatus } from '../routes/api/codex-auth/status'
import { handleCloudflareConnect } from '../routes/api/cloudflare/connect'
import { handleCloudflareDisconnect } from '../routes/api/cloudflare/disconnect'
import { handleCloudflareStatus } from '../routes/api/cloudflare/status'
import { handleDeployRun } from '../routes/api/deploy/run'
import { handleDeployWorker } from '../routes/api/deploy/worker'
import { handleRuntimeAction } from '../routes/api/runtime/action'

describe('buildAgentPlan', () => {
  it('creates a Cloudflare deployment plan from a plain-language idea', () => {
    const plan = buildAgentPlan({
      idea: 'A bakery preorder app',
      audience: 'bakery owner',
      deploymentTarget: 'Cloudflare Worker',
    })

    expect(plan.summary).toContain('A bakery preorder app')
    expect(plan.goal).toMatchObject({
      status: 'active',
      objective:
        'Build and deploy A bakery preorder app as a Cloudflare-native web app.',
    })
    expect(plan.goal.successCriteria).toContain(
      'The implementation runs as a Cloudflare Worker using the GhostBuild Cloudflare stack.',
    )
    expect(plan.deployment.workerName).toBe('a-bakery-preorder-app')
    expect(plan.stack.map((item) => item.name)).toContain('Cloudflare Think')
    expect(plan.defaults.mcpServers).toContainEqual({
      name: 'Cloudflare API',
      url: 'https://mcp.cloudflare.com/mcp',
    })
    expect(plan.defaults.model).toBe('gpt-5.5')
    expect(plan.defaults.reasoning).toBe('low')
    expect(plan.defaults.provisioning).toContain(
      'Create or link a Cloudflare account after user authorization',
    )
    expect(plan.defaults.credentialStorage).toContain(
      'ChatGPT/Codex token material is encrypted in HttpOnly cookies',
    )
    expect(plan.defaults.paymentFlow).toContain(
      'Cloudflare and Stripe handle payment collection for paid infrastructure',
    )
    expect(plan.defaults.modelProvider).toContain('ChatGPT/Codex sign-in')
    expect(plan.deployment.sessionId).toMatch(/^session_/)
    expect(plan.deployment.projectId).toMatch(/^project_/)
    expect(plan.phases).toHaveLength(7)
    expect(plan.phases[0]).toMatchObject({
      title: 'Prepare the project source',
      status: 'ready',
    })
    expect(plan.phases[0].detail).toContain('official Cloudflare')
    expect(plan.phases[1]).toMatchObject({
      title: 'Connect model auth',
      status: 'blocked',
    })
    expect(plan.phases[1].detail).toContain('Codex plan allowance')
    expect(plan.phases[2]).toMatchObject({
      title: 'Set model policy',
      status: 'ready',
    })
    expect(plan.phases[2].detail).toContain('gpt-5.5 with low reasoning')
  })

  it('keeps deployment slug separate from durable session identity', () => {
    const first = buildAgentPlan({ idea: 'A bakery preorder app' })
    const second = buildAgentPlan({ idea: 'A bakery preorder app' })

    expect(first.deployment.workerName).toBe(second.deployment.workerName)
    expect(first.deployment.sessionId).not.toBe(second.deployment.sessionId)
  })

  it('evaluates goal status from run evidence', () => {
    const criteria = ['Preview works', 'Deploy is complete']

    expect(evaluateGoalStatus(criteria)).toBe('active')
    expect(
      evaluateGoalStatus(criteria, {
        blockers: ['Cloudflare account token is missing'],
      }),
    ).toBe('blocked')
    expect(
      evaluateGoalStatus(criteria, {
        completedCriteria: criteria,
      }),
    ).toBe('completed')
    expect(
      evaluateGoalStatus(criteria, {
        generated: true,
        previewReady: true,
        checksPassed: true,
        deployed: true,
      }),
    ).toBe('completed')
  })
})

describe('build execution progress', () => {
  it('shows generation ready but deploy blocked until Cloudflare and approval are ready', () => {
    const plan = buildAgentPlan({ idea: 'A docs portal' })
    const progress = buildExecutionProgress({
      authState: {
        mode: 'chatgpt-codex-oauth',
        status: 'connected',
        account: { email: 'user@example.com', planType: 'plus' },
      },
      cloudflareStatus: {
        status: 'missing-token',
        permissions: [],
        message: 'Missing token',
      },
      isPending: false,
      plan,
    })

    expect(progress.stages.find((stage) => stage.id === 'generate')).toMatchObject({
      status: 'ready',
    })
    expect(progress.stages.find((stage) => stage.id === 'deploy')).toMatchObject({
      status: 'blocked',
    })
  })

  it('keeps deploy queued after approval until generation and checks execute', () => {
    const plan = buildAgentPlan({ idea: 'A docs portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const checkResult = runGeneratedWorkerChecks(generatedApp)
    const progress = buildExecutionProgress({
      authState: {
        mode: 'chatgpt-codex-oauth',
        status: 'connected',
        account: { email: 'user@example.com', planType: 'plus' },
      },
      cloudflareStatus: {
        status: 'connected',
        accountId: 'account_123',
        accountName: 'Acme Cloudflare',
        permissions: ['Workers Scripts Write'],
        message: 'Connected',
      },
      checkResult,
      deployApproval: {
        id: 'approval_1',
        presetId: 'deploy',
        action: 'deploy_worker',
        resource: plan.deployment.workerName,
        risk: 'medium',
        confirmedAt: '2026-05-12T00:00:00.000Z',
        confirmedBy: 'user@example.com',
        accountId: 'account_123',
        accountName: 'Acme Cloudflare',
        bindings: plan.deployment.bindings,
        workerName: plan.deployment.workerName,
        hasPaidAction: false,
        hasDestructiveAction: false,
      },
      generatedApp,
      isPending: false,
      plan,
      preview: createBuildPreviewResult({
        checkResult,
        generatedApp,
        origin: 'https://ghost.test',
      }),
    })

    expect(progress.stages.find((stage) => stage.id === 'approval')).toMatchObject({
      status: 'completed',
    })
    expect(progress.stages.find((stage) => stage.id === 'deploy')).toMatchObject({
      status: 'queued',
    })
  })

  it('marks deploy complete when Cloudflare returns a deploy result', () => {
    const plan = buildAgentPlan({ idea: 'A deployed portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const checkResult = runGeneratedWorkerChecks(generatedApp)
    const progress = buildExecutionProgress({
      authState: {
        mode: 'chatgpt-codex-oauth',
        status: 'connected',
        account: { email: 'user@example.com', planType: 'plus' },
      },
      checkResult,
      cloudflareStatus: {
        status: 'connected',
        accountId: 'account_123',
        permissions: ['Workers Scripts Write'],
        message: 'Connected',
      },
      deployApproval: {
        id: 'approval_1',
        presetId: 'deploy',
        action: 'deploy_worker',
        resource: plan.deployment.workerName,
        risk: 'medium',
        confirmedAt: '2026-05-12T00:00:00.000Z',
        confirmedBy: 'user@example.com',
        accountId: 'account_123',
        bindings: plan.deployment.bindings,
        workerName: plan.deployment.workerName,
        hasPaidAction: false,
        hasDestructiveAction: false,
      },
      deployResult: {
        status: 'deployed',
        accountId: 'account_123',
        dashboardUrl:
          'https://dash.cloudflare.com/account_123/workers/services/view/a-deployed-portal/production',
        deployedAt: '2026-05-12T00:00:00.000Z',
        workerName: plan.deployment.workerName,
      },
      generatedApp,
      isPending: false,
      plan,
      preview: createBuildPreviewResult({
        checkResult,
        generatedApp,
        origin: 'https://ghost.test',
      }),
    })

    expect(progress.stages.find((stage) => stage.id === 'deploy')).toMatchObject({
      status: 'completed',
    })
  })

  it('marks generation complete when Worker files exist', () => {
    const plan = buildAgentPlan({ idea: 'A generated portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const progress = buildExecutionProgress({
      authState: {
        mode: 'chatgpt-codex-oauth',
        status: 'connected',
        account: { email: 'user@example.com', planType: 'plus' },
      },
      cloudflareStatus: {
        status: 'connected',
        accountId: 'account_123',
        permissions: [],
        message: 'Connected',
      },
      generatedApp,
      isPending: false,
      plan,
    })

    expect(generatedApp.files.map((file) => file.path)).toContain(
      'wrangler.jsonc',
    )
    expect(progress.stages.find((stage) => stage.id === 'generate')).toMatchObject({
      status: 'completed',
    })
    expect(progress.stages.find((stage) => stage.id === 'preview')).toMatchObject({
      status: 'queued',
    })
  })

  it('blocks deploy until generated files pass checks', () => {
    const plan = buildAgentPlan({ idea: 'A generated portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const progress = buildExecutionProgress({
      authState: {
        mode: 'chatgpt-codex-oauth',
        status: 'connected',
        account: { email: 'user@example.com', planType: 'plus' },
      },
      cloudflareStatus: {
        status: 'connected',
        accountId: 'account_123',
        permissions: [],
        message: 'Connected',
      },
      deployApproval: {
        id: 'approval_1',
        presetId: 'deploy',
        action: 'deploy_worker',
        resource: plan.deployment.workerName,
        risk: 'medium',
        confirmedAt: '2026-05-12T00:00:00.000Z',
        confirmedBy: 'user@example.com',
        accountId: 'account_123',
        bindings: plan.deployment.bindings,
        workerName: plan.deployment.workerName,
        hasPaidAction: false,
        hasDestructiveAction: false,
      },
      generatedApp,
      isPending: false,
      plan,
    })

    expect(progress.stages.find((stage) => stage.id === 'checks')).toMatchObject({
      status: 'ready',
    })
    expect(progress.stages.find((stage) => stage.id === 'deploy')).toMatchObject({
      status: 'blocked',
    })
  })

  it('marks preview complete when preview URL exists', () => {
    const plan = buildAgentPlan({ idea: 'A preview portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const checkResult = runGeneratedWorkerChecks(generatedApp)
    const progress = buildExecutionProgress({
      authState: {
        mode: 'chatgpt-codex-oauth',
        status: 'connected',
        account: { email: 'user@example.com', planType: 'plus' },
      },
      checkResult,
      cloudflareStatus: {
        status: 'connected',
        accountId: 'account_123',
        permissions: [],
        message: 'Connected',
      },
      generatedApp,
      isPending: false,
      plan,
      preview: createBuildPreviewResult({
        checkResult,
        generatedApp,
        origin: 'https://ghost.test',
      }),
    })

    expect(progress.stages.find((stage) => stage.id === 'preview')).toMatchObject({
      status: 'completed',
    })
  })
})

describe('generated Worker checks', () => {
  it('passes generated Worker artifact checks', () => {
    const plan = buildAgentPlan({ idea: 'A generated portal' })
    const result = runGeneratedWorkerChecks(generateWorkerAppFromPlan(plan))

    expect(result.status).toBe('passed')
    expect(result.checks.every((check) => check.status === 'passed')).toBe(true)
  })

  it('fails when required Worker files are missing', () => {
    const result = runGeneratedWorkerChecks({
      workerName: 'missing-files',
      summary: 'Broken app',
      generatedAt: '2026-05-12T00:00:00.000Z',
      files: [],
    })

    expect(result.status).toBe('failed')
    expect(result.checks.some((check) => check.status === 'failed')).toBe(true)
  })

  it('checks that generated artifacts include a deployable Worker module', () => {
    const plan = buildAgentPlan({ idea: 'A generated portal' })
    const result = runGeneratedWorkerChecks(generateWorkerAppFromPlan(plan))

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'worker.js content',
        status: 'passed',
      }),
    )
  })

  it('repairs failed generated Worker artifacts from the active plan baseline', () => {
    const plan = buildAgentPlan({ idea: 'A repairable portal' })
    const generatedApp = {
      ...generateWorkerAppFromPlan(plan),
      files: generateWorkerAppFromPlan(plan).files.filter(
        (file) => file.path !== 'worker.js',
      ),
    }
    const repair = repairGeneratedWorkerApp({
      checkResult: runGeneratedWorkerChecks(generatedApp),
      generatedApp,
      plan,
    })

    expect(repair.status).toBe('repaired')
    expect(repair.repairedFiles).toContain('worker.js')
    expect(runGeneratedWorkerChecks(repair.repairedApp).status).toBe('passed')
  })

  it('applies safe generated Worker file patches before checks run again', () => {
    const plan = buildAgentPlan({ idea: 'A patchable portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const originalReadme = generatedApp.files.find(
      (file) => file.path === 'README.md',
    )

    if (!originalReadme) {
      throw new Error('README missing')
    }

    const patchResult = applyGeneratedWorkerPatches(generatedApp, [
      {
        operation: 'upsert',
        path: 'README.md',
        content: `${originalReadme.content}\nPatched by agent.\n`,
      },
    ])

    expect(patchResult.changedFiles).toContain('README.md')
    expect(
      patchResult.patchedApp.files.find((file) => file.path === 'README.md')
        ?.content,
    ).toContain('Patched by agent.')
    expect(runGeneratedWorkerChecks(patchResult.patchedApp).status).toBe('passed')
  })

  it('rejects generated Worker patches outside the app boundary', () => {
    const plan = buildAgentPlan({ idea: 'A patch boundary portal' })

    expect(() =>
      applyGeneratedWorkerPatches(generateWorkerAppFromPlan(plan), [
        {
          operation: 'upsert',
          path: '../secrets.txt',
          content: 'nope',
        },
      ]),
    ).toThrow('inside the app')
  })

  it('applies model-proposed generated Worker patches through the safe patcher', async () => {
    const plan = buildAgentPlan({ idea: 'An agent patch portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const brokenApp = {
      ...generatedApp,
      files: generatedApp.files.filter((file) => file.path !== 'worker.js'),
    }

    await expect(
      proposeAndApplyGeneratedWorkerPatches({
        checkResult: runGeneratedWorkerChecks(brokenApp),
        generatedApp: brokenApp,
        goal: plan.goal.objective,
        proposer: async () => ({
          patches: [
            {
              operation: 'upsert',
              path: 'worker.js',
              content:
                generatedApp.files.find((file) => file.path === 'worker.js')
                  ?.content ?? '',
            },
          ],
        }),
      }),
    ).resolves.toMatchObject({
      changedFiles: ['worker.js'],
      proposedPatches: [
        {
          operation: 'upsert',
          path: 'worker.js',
        },
      ],
    })
  })
})

describe('build preview', () => {
  it('creates preview URLs only after checks pass', () => {
    const plan = buildAgentPlan({ idea: 'A preview portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const preview = createBuildPreviewResult({
      checkResult: runGeneratedWorkerChecks(generatedApp),
      generatedApp,
      origin: 'https://ghost.test',
    })

    expect(preview.url).toBe('https://ghost.test/preview/a-preview-portal')
    expect(preview.healthUrl).toBe(
      'https://ghost.test/preview/a-preview-portal/api/health',
    )
  })

  it('blocks preview URL creation when checks fail', () => {
    expect(() =>
      createBuildPreviewResult({
        checkResult: {
          status: 'failed',
          checkedAt: '2026-05-12T00:00:00.000Z',
          checks: [],
        },
        generatedApp: {
          workerName: 'broken-preview',
          summary: 'Broken',
          generatedAt: '2026-05-12T00:00:00.000Z',
          files: [],
        },
        origin: 'https://ghost.test',
      }),
    ).toThrow('passing artifact checks')
  })
})

describe('build pipeline', () => {
  it('runs generate, checks, and preview as one server-side pipeline', () => {
    const plan = buildAgentPlan({ idea: 'A pipeline portal' })
    const pipeline = runGeneratedWorkerBuildPipeline({
      origin: 'https://ghost.test',
      plan,
    })

    expect(pipeline.generatedApp.workerName).toBe(plan.deployment.workerName)
    expect(pipeline.checkResult.status).toBe('passed')
    expect(pipeline.preview?.url).toBe(
      'https://ghost.test/preview/a-pipeline-portal',
    )
  })

  it('runs build, preview, approval enforcement, and Cloudflare deploy as one pipeline', async () => {
    const plan = buildAgentPlan({ idea: 'A deploy pipeline portal' })
    const approval = createDeployApprovalRecord({
      accountId: 'account_123',
      accountName: 'Acme Cloudflare',
      bindings: plan.deployment.bindings,
      confirmedBy: 'user@example.com',
      hasDestructiveAction: false,
      hasPaidAction: false,
      workerName: plan.deployment.workerName,
    })
    const fetcher = (async () =>
      Response.json({
        success: true,
        result: { id: plan.deployment.workerName },
      })) as typeof fetch

    await expect(
      runGeneratedWorkerBuildDeployPipeline({
        approval,
        cloudflareStatus: {
          status: 'connected',
          accountId: 'account_123',
          permissions: ['Workers Scripts Write'],
          message: 'Connected',
        },
        fetcher,
        origin: 'https://ghost.test',
        plan,
        token: 'cf-token',
      }),
    ).resolves.toMatchObject({
      checkResult: { status: 'passed' },
      deployResult: {
        status: 'deployed',
        workerName: plan.deployment.workerName,
      },
      preview: {
        status: 'ready',
      },
    })
  })

  it('blocks the combined build and deploy pipeline without matching approval', async () => {
    const plan = buildAgentPlan({ idea: 'A blocked deploy pipeline portal' })
    const fetcher = (async () => {
      throw new Error('unexpected upload')
    }) as typeof fetch

    await expect(
      runGeneratedWorkerBuildDeployPipeline({
        cloudflareStatus: {
          status: 'connected',
          accountId: 'account_123',
          permissions: ['Workers Scripts Write'],
          message: 'Connected',
        },
        fetcher,
        origin: 'https://ghost.test',
        plan,
        token: 'cf-token',
      }),
    ).rejects.toThrow('requires explicit confirmation')
  })
})

describe('model catalog', () => {
  it('backs the default model policy from catalog metadata', () => {
    expect(defaultModel.id).toBe('gpt-5.5')
    expect(defaultModel.defaultReasoningEffort).toBe('low')
    expect(defaultModel.availabilityNotes).toContain('ChatGPT/Codex OAuth')
  })

  it('normalizes unsupported reasoning to the catalog default', () => {
    expect(normalizeReasoningEffort('gpt-5.5')).toBe('low')
  })
})

describe('model auth provider', () => {
  it('requires Codex OAuth credentials', () => {
    expect(() =>
      resolveModelRuntimeAuth({
        codexAccount: {
          email: 'user@example.com',
          planType: 'plus',
        },
      }),
    ).toThrow('ChatGPT/Codex OAuth credentials are required.')
  })

  it('resolves only Codex OAuth runtime credentials', () => {
    const auth = resolveModelRuntimeAuth({
      codexAccessToken: 'codex-token',
      codexAccount: {
        email: 'user@example.com',
        planType: 'plus',
      },
    })

    expect(auth).toMatchObject({
      mode: 'chatgpt-codex-oauth',
      accessToken: 'codex-token',
    })
  })

  it('does not treat missing ChatGPT account metadata as connected', () => {
    expect(
      summarizeCodexAuthState({
        account: { email: 'user@example.com' },
        hasToken: true,
      }),
    ).toMatchObject({ status: 'unsupported' })
  })

  it('shows expired Codex auth as recoverable', () => {
    expect(
      summarizeCodexAuthState({
        account: {
          email: 'user@example.com',
          planType: 'plus',
        },
        hasToken: false,
      }),
    ).toMatchObject({
      status: 'expired',
      recoveryUrl: '/api/codex-auth/start',
    })
  })
})

describe('Codex OAuth routes', () => {
  it('reports unconfigured OAuth start without setting local auth state', async () => {
    const response = await createOAuthStart({
      redirectUri: 'https://ghost.test/api/codex-auth/callback',
    })

    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('not configured'),
    })
  })

  it('starts PKCE OAuth with state and verifier cookies', async () => {
    const response = await createOAuthStart({
      clientId: 'client_123',
      authorizeUrl: 'https://auth.test/oauth/authorize',
      redirectUri: 'https://ghost.test/api/codex-auth/callback',
    })
    const location = response.headers.get('location')
    const cookieHeader = response.headers.get('set-cookie') ?? ''

    expect(response.status).toBe(302)
    expect(location).toContain('https://auth.test/oauth/authorize')
    expect(location).toContain('code_challenge_method=S256')
    expect(cookieHeader).toContain(codexOAuthStateCookie)
    expect(cookieHeader).toContain(codexOAuthVerifierCookie)
  })

  it('rejects OAuth callbacks with missing or mismatched state', async () => {
    const response = await exchangeOAuthCallback(
      new Request('https://ghost.test/api/codex-auth/callback?code=abc&state=bad', {
        headers: {
          cookie: `${codexOAuthStateCookie}=expected; ${codexOAuthVerifierCookie}=verifier`,
        },
      }),
      {
        clientId: 'client_123',
        tokenUrl: 'https://auth.test/oauth/token',
        redirectUri: 'https://ghost.test/api/codex-auth/callback',
        cookieSecret: 'test-secret',
      },
    )

    expect(response.status).toBe(400)
  })

  it('does not treat malformed or expired token cookies as connected', async () => {
    process.env.CODEX_OAUTH_COOKIE_SECRET = 'test-secret'

    await expect(
      readCodexTokenFromRequest(
        new Request('https://ghost.test', {
          headers: {
            cookie: `${codexOAuthTokenCookie}=not-a-valid-token`,
          },
        }),
      ),
    ).resolves.toBeUndefined()

    const expired = await sealCodexTokenCookieValue(
      {
        accessToken: 'expired-token',
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
      'test-secret',
    )

    await expect(
      readCodexTokenFromRequest(
        new Request('https://ghost.test', {
          headers: {
            cookie: `${codexOAuthTokenCookie}=${expired}`,
          },
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it('logout expires Codex OAuth cookies', async () => {
    const response = await createCodexLogout(new Request('https://ghost.test'), {
      redirectUri: 'https://ghost.test/api/codex-auth/callback',
    })
    const cookieHeader = response.headers.get('set-cookie') ?? ''

    expect(response.status).toBe(302)
    expect(cookieHeader).toContain(codexOAuthStateCookie)
    expect(cookieHeader).toContain(codexOAuthTokenCookie)
    expect(cookieHeader).toContain('Max-Age=0')
  })

  it('routes OAuth start through deployment env configuration', async () => {
    const response = await withCodexOAuthEnv(() =>
      handleCodexOAuthStart(new Request('https://ghost.test/api/codex-auth/start')),
    )
    const location = response.headers.get('location') ?? ''

    expect(response.status).toBe(302)
    expect(location).toContain('https://auth.test/oauth/authorize')
    expect(location).toContain('client_id=client_123')
    expect(response.headers.get('set-cookie')).toContain(codexOAuthStateCookie)
  })

  it('routes OAuth callback through token exchange and sets auth cookies', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        access_token: 'codex-token',
        expires_in: 3600,
        refresh_token: 'refresh-token',
        account: {
          id: 'account_123',
          plan: 'plus',
        },
        user: {
          email: 'user@example.com',
          id: 'user_123',
        },
      }),
    )
    const response = await withCodexOAuthEnv(() =>
      handleCodexOAuthCallback(
        new Request(
          'https://ghost.test/api/codex-auth/callback?code=abc&state=state_123',
          {
            headers: {
              cookie: `${codexOAuthStateCookie}=state_123; ${codexOAuthVerifierCookie}=verifier_123`,
            },
          },
        ),
      ),
    )
    const cookieHeader = response.headers.get('set-cookie') ?? ''

    expect(response.status).toBe(302)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.test/oauth/token',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(cookieHeader).toContain(codexOAuthAccountCookie)
    expect(cookieHeader).toContain(codexOAuthTokenCookie)
    expect(cookieHeader).toContain('Max-Age=2592000')
    fetchMock.mockRestore()
  })

  it('routes OAuth status through refresh token recovery', async () => {
    process.env.CODEX_OAUTH_COOKIE_SECRET = 'test-secret'
    const expired = await sealCodexTokenCookieValue(
      {
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
      'test-secret',
    )
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        access_token: 'fresh-token',
        expires_in: 3600,
      }),
    )
    const response = await withCodexOAuthEnv(() =>
      handleCodexOAuthStatus(
        new Request('https://ghost.test/api/codex-auth/status', {
          headers: {
            cookie: [
              `${codexOAuthAccountCookie}=${encodeURIComponent(JSON.stringify({ email: 'user@example.com', planType: 'plus' }))}`,
              `${codexOAuthTokenCookie}=${expired}`,
            ].join('; '),
          },
        }),
      ),
    )

    await expect(response.json()).resolves.toMatchObject({
      status: 'connected',
    })
    expect(response.headers.get('set-cookie')).toContain(codexOAuthTokenCookie)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.test/oauth/token',
      expect.objectContaining({ method: 'POST' }),
    )
    fetchMock.mockRestore()
  })

  it('routes OAuth status and does not connect malformed cookies', async () => {
    const response = await withCodexOAuthEnv(() =>
      handleCodexOAuthStatus(
        new Request('https://ghost.test/api/codex-auth/status', {
          headers: {
            cookie: [
              `${codexOAuthAccountCookie}=${encodeURIComponent(JSON.stringify({ email: 'user@example.com', planType: 'plus' }))}`,
              `${codexOAuthTokenCookie}=not-a-valid-token`,
            ].join('; '),
          },
        }),
      ),
    )

    await expect(response.json()).resolves.toMatchObject({
      status: 'expired',
    })
  })

  it('routes OAuth logout through cookie expiration', async () => {
    const response = await withCodexOAuthEnv(() =>
      handleCodexOAuthLogout(
        new Request('https://ghost.test/api/codex-auth/logout', {
          method: 'POST',
        }),
      ),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('set-cookie')).toContain(codexOAuthTokenCookie)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

describe('agent stream events', () => {
  it('round-trips terminal completion events', () => {
    const plan = buildAgentPlan({ idea: 'A salon scheduler' })
    const event = parseAgentRunEvent(
      encodeAgentRunEvent({
        type: 'completion',
        plan,
        billingSummary: 'ChatGPT/Codex OAuth using eligible Codex plan allowance.',
      }),
    )

    expect(event?.type).toBe('completion')
    expect(event && isTerminalAgentRunEvent(event)).toBe(true)
  })

  it('surfaces malformed payloads as readable errors', () => {
    expect(() => parseAgentRunEvent('data: not-json\n\n')).toThrow(
      'malformed stream data',
    )
  })
})

describe('permission presets', () => {
  it('allows non-destructive planning without confirmation', () => {
    expect(() =>
      assertActionAllowed('planning', 'inspect_cloudflare_docs'),
    ).not.toThrow()
  })

  it('blocks paid Cloudflare actions without matching confirmation', () => {
    expect(() =>
      assertActionAllowed('paid-cloudflare-action', 'buy_domain'),
    ).toThrow('requires explicit confirmation')
  })

  it('accepts auditable confirmation for paid actions', () => {
    expect(() =>
      assertActionAllowed('paid-cloudflare-action', 'buy_domain', {
        id: 'approval_1',
        presetId: 'paid-cloudflare-action',
        action: 'buy_domain',
        resource: 'example.com',
        risk: 'high',
        estimatedCost: '$12/year',
        confirmedAt: new Date('2026-05-12T00:00:00Z').toISOString(),
        confirmedBy: 'user@example.com',
      }),
    ).not.toThrow()
  })
})

describe('Cloudflare connection status', () => {
  it('reports missing Cloudflare tokens without calling the network', async () => {
    const fetcher = (() => {
      throw new Error('unexpected fetch')
    }) as typeof fetch

    await expect(verifyCloudflareConnection('', fetcher)).resolves.toMatchObject({
      status: 'missing-token',
      permissions: [],
    })
  })

  it('returns account and token permission names for valid tokens', async () => {
    const fetcher = (async (url: RequestInfo | URL) => {
      const href = String(url)

      if (href.endsWith('/user/tokens/verify')) {
        return Response.json({
          success: true,
          result: {
            policies: [
              {
                permission_groups: [{ name: 'Workers Scripts Write' }],
              },
            ],
          },
        })
      }

      return Response.json({
        success: true,
        result: [{ id: 'account_123', name: 'Acme Cloudflare' }],
      })
    }) as typeof fetch

    await expect(
      verifyCloudflareConnection('cf-token', fetcher),
    ).resolves.toMatchObject({
      status: 'connected',
      accountId: 'account_123',
      accountName: 'Acme Cloudflare',
      permissions: ['Workers Scripts Write'],
    })
  })

  it('reads encrypted user Cloudflare token cookies and ignores malformed ones', async () => {
    process.env.CLOUDFLARE_TOKEN_COOKIE_SECRET = 'test-secret'

    await expect(
      readCloudflareTokenFromRequest(
        new Request('https://ghost.test', {
          headers: {
            cookie: `${cloudflareTokenCookie}=not-valid`,
          },
        }),
      ),
    ).resolves.toBeUndefined()

    const sealed = await sealCloudflareTokenCookieValue(
      { token: 'cf-token' },
      'test-secret',
    )

    await expect(
      readCloudflareTokenFromRequest(
        new Request('https://ghost.test', {
          headers: {
            cookie: `${cloudflareTokenCookie}=${sealed}`,
          },
        }),
      ),
    ).resolves.toBe('cf-token')
  })

  it('connects, verifies, and disconnects Cloudflare through HTTP route handlers', async () => {
    process.env.CODEX_OAUTH_COOKIE_SECRET = 'test-secret'
    const fetcher = createCloudflareDeployRouteFetcher('route-worker')
    const connectResponse = await handleCloudflareConnect(
      new Request('https://ghost.test/api/cloudflare/connect', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token: 'cf-token' }),
      }),
      fetcher,
    )
    const connectCookie = connectResponse.headers.get('set-cookie') ?? ''

    expect(connectResponse.status).toBe(200)
    expect(connectCookie).toContain(cloudflareTokenCookie)

    const statusResponse = await handleCloudflareStatus(
      new Request('https://ghost.test/api/cloudflare/status', {
        headers: {
          cookie: connectCookie.split(';')[0],
        },
      }),
      fetcher,
    )

    await expect(statusResponse.json()).resolves.toMatchObject({
      status: 'connected',
      accountId: 'account_123',
    })

    const disconnectResponse = await handleCloudflareDisconnect()

    expect(disconnectResponse.status).toBe(200)
    expect(disconnectResponse.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('rejects invalid Cloudflare tokens through the connect route', async () => {
    process.env.CODEX_OAUTH_COOKIE_SECRET = 'test-secret'
    const response = await handleCloudflareConnect(
      new Request('https://ghost.test/api/cloudflare/connect', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token: 'bad-token' }),
      }),
      (async () =>
        Response.json(
          {
            success: false,
            errors: [{ message: 'invalid token' }],
          },
          { status: 403 },
        )) as typeof fetch,
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: {
        status: 'invalid-token',
        message: 'invalid token',
      },
    })
  })
})

describe('deploy approvals', () => {
  it('requires a deploy confirmation that matches the planned Worker', () => {
    const plan = buildAgentPlan({ idea: 'A docs portal' })

    expect(() => assertDeployActionAllowed(plan)).toThrow(
      'requires explicit confirmation',
    )

    const approval = createDeployApprovalRecord({
      accountId: 'account_123',
      accountName: 'Acme Cloudflare',
      bindings: plan.deployment.bindings,
      confirmedBy: 'user@example.com',
      hasDestructiveAction: false,
      hasPaidAction: false,
      workerName: plan.deployment.workerName,
    })

    expect(() => assertDeployActionAllowed(plan, approval)).not.toThrow()
  })

  it('records estimated cost and high risk for paid or destructive deploy approvals', () => {
    const approval = createDeployApprovalRecord({
      accountId: 'account_123',
      accountName: 'Acme Cloudflare',
      bindings: ['D1', 'R2'],
      confirmedBy: 'user@example.com',
      estimatedCost: '$12/year domain',
      hasDestructiveAction: true,
      hasPaidAction: true,
      workerName: 'paid-worker',
    })

    expect(approval).toMatchObject({
      estimatedCost: '$12/year domain',
      hasDestructiveAction: true,
      hasPaidAction: true,
      risk: 'high',
    })
  })
})

describe('runtime action executor', () => {
  it('blocks deploy actions until Cloudflare is connected and approval matches', () => {
    const plan = buildAgentPlan({ idea: 'A docs portal' })
    const approval = createDeployApprovalRecord({
      accountId: 'account_123',
      accountName: 'Acme Cloudflare',
      bindings: plan.deployment.bindings,
      confirmedBy: 'user@example.com',
      hasDestructiveAction: false,
      hasPaidAction: false,
      workerName: plan.deployment.workerName,
    })

    expect(() =>
      assertRuntimeActionAllowed({
        type: 'deploy_worker',
        plan,
        approval,
        cloudflareStatus: {
          status: 'missing-token',
          permissions: [],
          message: 'Missing token',
        },
      }),
    ).toThrow('Cloudflare account connection is required')

    expect(() =>
      assertRuntimeActionAllowed({
        type: 'deploy_worker',
        plan,
        approval,
        cloudflareStatus: {
          status: 'connected',
          accountId: 'other_account',
          permissions: [],
          message: 'Connected',
        },
      }),
    ).toThrow('connected account')

    expect(
      assertRuntimeActionAllowed({
        type: 'deploy_worker',
        plan,
        approval,
        cloudflareStatus: {
          status: 'connected',
          accountId: 'account_123',
          accountName: 'Acme Cloudflare',
          permissions: ['Workers Scripts Write'],
          message: 'Connected',
        },
      }),
    ).toMatchObject({
      status: 'allowed',
      action: 'deploy_worker',
      resource: plan.deployment.workerName,
    })
  })

  it('blocks paid and destructive runtime actions without matching confirmations', () => {
    expect(() =>
      assertRuntimeActionAllowed({
        type: 'paid_cloudflare_action',
        action: 'buy_domain',
        resource: 'example.com',
      }),
    ).toThrow('requires explicit confirmation')

    const confirmation = {
      id: 'approval_paid_1',
      presetId: 'paid-cloudflare-action',
      action: 'buy_domain',
      resource: 'example.com',
      risk: 'high',
      estimatedCost: '$12/year',
      confirmedAt: new Date('2026-05-12T00:00:00Z').toISOString(),
      confirmedBy: 'user@example.com',
    } satisfies ApprovalConfirmation

    expect(
      assertRuntimeActionAllowed({
        type: 'paid_cloudflare_action',
        action: 'buy_domain',
        resource: 'example.com',
        confirmation,
      }),
    ).toMatchObject({ status: 'allowed', action: 'buy_domain' })

    expect(() =>
      assertRuntimeActionAllowed({
        type: 'destructive_cloudflare_action',
        action: 'delete_worker',
        resource: 'old-worker',
      }),
    ).toThrow('requires explicit confirmation')
  })

  it('enforces paid and destructive runtime actions through the HTTP route', async () => {
    process.env.CODEX_OAUTH_COOKIE_SECRET = 'test-secret'
    const blockedResponse = await handleRuntimeAction(
      new Request('https://ghost.test/api/runtime/action', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await buildCodexRouteAuthCookieHeader(),
        },
        body: JSON.stringify({
          actionRequest: {
            type: 'paid_cloudflare_action',
            action: 'buy_domain',
            resource: 'example.com',
          },
        }),
      }),
    )

    expect(blockedResponse.status).toBe(400)
    await expect(blockedResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining('requires explicit confirmation'),
    })

    const allowedResponse = await handleRuntimeAction(
      new Request('https://ghost.test/api/runtime/action', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await buildCodexRouteAuthCookieHeader(),
        },
        body: JSON.stringify({
          actionRequest: {
            type: 'destructive_cloudflare_action',
            action: 'delete_worker',
            resource: 'old-worker',
            confirmation: {
              id: 'approval_destructive_1',
              presetId: 'destructive-cloudflare-action',
              action: 'delete_worker',
              resource: 'old-worker',
              risk: 'high',
              confirmedAt: new Date('2026-05-12T00:00:00Z').toISOString(),
              confirmedBy: 'user@example.com',
            },
          },
        }),
      }),
    )

    expect(allowedResponse.status).toBe(200)
    await expect(allowedResponse.json()).resolves.toMatchObject({
      result: {
        status: 'allowed',
        action: 'delete_worker',
        resource: 'old-worker',
      },
    })
  })
})

describe('Cloudflare Worker deploy executor', () => {
  it('uploads a module Worker only after checks, preview, Cloudflare, and approval pass', async () => {
    const plan = buildAgentPlan({ idea: 'A deployable portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const checkResult = runGeneratedWorkerChecks(generatedApp)
    const preview = createBuildPreviewResult({
      checkResult,
      generatedApp,
      origin: 'https://ghost.test',
    })
    const approval = createDeployApprovalRecord({
      accountId: 'account_123',
      accountName: 'Acme Cloudflare',
      bindings: plan.deployment.bindings,
      confirmedBy: 'user@example.com',
      hasDestructiveAction: false,
      hasPaidAction: false,
      workerName: plan.deployment.workerName,
    })
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })

      return Response.json({
        success: true,
        result: { id: plan.deployment.workerName },
      })
    }) as typeof fetch

    await expect(
      deployGeneratedWorkerApp({
        approval,
        checkResult,
        cloudflareStatus: {
          status: 'connected',
          accountId: 'account_123',
          accountName: 'Acme Cloudflare',
          permissions: ['Workers Scripts Write'],
          message: 'Connected',
        },
        generatedApp,
        plan,
        preview,
        token: 'cf-token',
        fetcher,
      }),
    ).resolves.toMatchObject({
      status: 'deployed',
      workerName: plan.deployment.workerName,
      accountId: 'account_123',
    })

    expect(calls[0]?.url).toContain(
      `/accounts/account_123/workers/scripts/${plan.deployment.workerName}`,
    )
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer cf-token',
    })
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData)
  })

  it('does not upload when deploy evidence or approval is incomplete', async () => {
    const plan = buildAgentPlan({ idea: 'A blocked deploy portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const checkResult = runGeneratedWorkerChecks(generatedApp)
    const fetcher = (async () => {
      throw new Error('unexpected upload')
    }) as typeof fetch

    await expect(
      deployGeneratedWorkerApp({
        checkResult,
        cloudflareStatus: {
          status: 'connected',
          accountId: 'account_123',
          permissions: [],
          message: 'Connected',
        },
        generatedApp,
        plan,
        token: 'cf-token',
        fetcher,
      }),
    ).rejects.toThrow('Preview readiness')

    await expect(
      deployGeneratedWorkerApp({
        approval: createDeployApprovalRecord({
          accountId: 'account_123',
          bindings: plan.deployment.bindings,
          confirmedBy: 'user@example.com',
          hasDestructiveAction: false,
          hasPaidAction: false,
          workerName: plan.deployment.workerName,
        }),
        checkResult,
        cloudflareStatus: {
          status: 'connected',
          accountId: 'account_123',
          permissions: [],
          message: 'Connected',
        },
        generatedApp,
        plan,
        preview: createBuildPreviewResult({
          checkResult,
          generatedApp,
          origin: 'https://ghost.test',
        }),
        token: 'cf-token',
        fetcher,
      }),
    ).rejects.toThrow('Workers write permission')
  })

  it('does not synthesize a deployment when the generated artifact lacks worker.js', async () => {
    const plan = buildAgentPlan({ idea: 'A missing Worker module portal' })
    const generatedApp = {
      ...generateWorkerAppFromPlan(plan),
      files: generateWorkerAppFromPlan(plan).files.filter(
        (file) => file.path !== 'worker.js',
      ),
    }
    const checkResult = {
      status: 'passed' as const,
      checkedAt: '2026-05-12T00:00:00.000Z',
      checks: [],
    }
    const approval = createDeployApprovalRecord({
      accountId: 'account_123',
      bindings: plan.deployment.bindings,
      confirmedBy: 'user@example.com',
      hasDestructiveAction: false,
      hasPaidAction: false,
      workerName: plan.deployment.workerName,
    })
    const fetcher = (async () => {
      throw new Error('unexpected upload')
    }) as typeof fetch

    await expect(
      deployGeneratedWorkerApp({
        approval,
        checkResult,
        cloudflareStatus: {
          status: 'connected',
          accountId: 'account_123',
          permissions: ['Workers Scripts Write'],
          message: 'Connected',
        },
        generatedApp,
        plan,
        preview: {
          status: 'ready',
          url: 'https://ghost.test/preview/missing',
          healthUrl: 'https://ghost.test/preview/missing/api/health',
          createdAt: '2026-05-12T00:00:00.000Z',
        },
        token: 'cf-token',
        fetcher,
      }),
    ).rejects.toThrow('missing worker.js')
  })
})

describe('Cloudflare deploy route', () => {
  it('blocks deploy at the HTTP route without matching approval', async () => {
    process.env.CODEX_OAUTH_COOKIE_SECRET = 'test-secret'
    const plan = buildAgentPlan({ idea: 'A route deploy portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const checkResult = runGeneratedWorkerChecks(generatedApp)
    const preview = createBuildPreviewResult({
      checkResult,
      generatedApp,
      origin: 'https://ghost.test',
    })
    const fetcher = createCloudflareDeployRouteFetcher(plan.deployment.workerName)

    const response = await handleDeployWorker(
      new Request('https://ghost.test/api/deploy/worker', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await buildRouteAuthCookieHeader(),
        },
        body: JSON.stringify({
          checkResult,
          generatedApp,
          plan,
          preview,
        }),
      }),
      fetcher,
    )

    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('requires explicit confirmation'),
    })
    expect(response.status).toBe(400)
  })

  it('deploys through the HTTP route after auth, Cloudflare, checks, preview, and approval pass', async () => {
    process.env.CODEX_OAUTH_COOKIE_SECRET = 'test-secret'
    const plan = buildAgentPlan({ idea: 'A route deploy portal' })
    const generatedApp = generateWorkerAppFromPlan(plan)
    const checkResult = runGeneratedWorkerChecks(generatedApp)
    const preview = createBuildPreviewResult({
      checkResult,
      generatedApp,
      origin: 'https://ghost.test',
    })
    const approval = createDeployApprovalRecord({
      accountId: 'account_123',
      bindings: plan.deployment.bindings,
      confirmedBy: 'user@example.com',
      hasDestructiveAction: false,
      hasPaidAction: false,
      workerName: plan.deployment.workerName,
    })
    const fetcher = createCloudflareDeployRouteFetcher(plan.deployment.workerName)

    const response = await handleDeployWorker(
      new Request('https://ghost.test/api/deploy/worker', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await buildRouteAuthCookieHeader(),
        },
        body: JSON.stringify({
          approval,
          checkResult,
          generatedApp,
          plan,
          preview,
        }),
      }),
      fetcher,
    )

    await expect(response.json()).resolves.toMatchObject({
      deployResult: {
        status: 'deployed',
        workerName: plan.deployment.workerName,
      },
    })
    expect(response.status).toBe(200)
  })
})

describe('Cloudflare build and deploy route', () => {
  it('blocks the combined HTTP route without Codex auth', async () => {
    const response = await handleDeployRun(
      new Request('https://ghost.test/api/deploy/run', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ plan: buildAgentPlan({ idea: 'A route app' }) }),
      }),
      createCloudflareDeployRouteFetcher('route-worker'),
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Codex sign-in is required.',
    })
  })

  it('runs build, preview, and deploy through the combined HTTP route with approval', async () => {
    process.env.CODEX_OAUTH_COOKIE_SECRET = 'test-secret'
    const plan = buildAgentPlan({ idea: 'A combined route deploy portal' })
    const approval = createDeployApprovalRecord({
      accountId: 'account_123',
      bindings: plan.deployment.bindings,
      confirmedBy: 'user@example.com',
      hasDestructiveAction: false,
      hasPaidAction: false,
      workerName: plan.deployment.workerName,
    })
    const response = await handleDeployRun(
      new Request('https://ghost.test/api/deploy/run', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await buildRouteAuthCookieHeader(),
        },
        body: JSON.stringify({ approval, plan }),
      }),
      createCloudflareDeployRouteFetcher(plan.deployment.workerName),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      pipeline: {
        checkResult: { status: 'passed' },
        deployResult: {
          status: 'deployed',
          workerName: plan.deployment.workerName,
        },
        preview: { status: 'ready' },
      },
    })
  })
})

describe('builder sessions', () => {
  it('persists selected source, model policy, and run identity', () => {
    const session = createBuilderSession({
      idea: 'A client portal',
      projectSource: {
        type: 'github',
        repository: 'owner/repo',
      },
      model: 'gpt-5.5',
      reasoningEffort: 'low',
      goal: {
        objective: 'Ship the client portal',
        status: 'active',
        successCriteria: ['Preview works'],
      },
      now: new Date('2026-05-12T00:00:00Z'),
    })

    expect(session.projectId).toMatch(/^import_/)
    expect(session.selectedSource).toMatchObject({ type: 'github' })
    expect(session.modelPolicy).toMatchObject({
      reasoningEffort: 'low',
    })
    expect(session.goal.objective).toBe('Ship the client portal')
    expect(session.runStatus).toBe('idle')
  })

  it('stores owner-scoped session snapshots for return-to-session', () => {
    const store = new Map()
    const plan = buildAgentPlan({ idea: 'A client portal' })
    const ownerId = ownerIdFromCodexAccount({
      email: 'user@example.com',
      planType: 'plus',
    })

    expect(ownerId).toBe('user@example.com')
    if (!ownerId) {
      throw new Error('owner id missing')
    }

    upsertBuilderSessionSnapshot(
      {
        ownerId,
        request: {
          idea: 'A client portal',
          audience: 'non-technical founder',
          deploymentTarget: 'Cloudflare Worker',
          projectSource: {
            type: 'new',
            starter: 'TanStack Start',
            command: 'pnpm create cloudflare@latest',
            sourceUrl: 'https://developers.cloudflare.com/',
          },
          model: 'gpt-5.5',
          reasoningEffort: 'low',
        },
        plan,
        submittedPrompt: 'A client portal',
        goalTimeline: [
          {
            role: 'system',
            title: 'Goal update 1',
            body: 'Goal updated from "A" to "B".',
          },
        ],
        updatedAt: '2026-05-12T00:00:00.000Z',
      },
      store,
    )

    expect(
      getBuilderSessionSnapshot(ownerId, plan.deployment.sessionId, store)
        ?.goalTimeline[0]?.body,
    ).toContain('Goal updated')
    expect(listBuilderSessionSnapshots(ownerId, store)).toHaveLength(1)
    expect(
      summarizeBuilderSessionSnapshot(
        listBuilderSessionSnapshots(ownerId, store)[0],
      ),
    ).toMatchObject({
      sessionId: plan.deployment.sessionId,
      workerName: plan.deployment.workerName,
    })
    expect(listBuilderSessionSnapshots('other-user', store)).toHaveLength(0)
  })
})

async function withCodexOAuthEnv<T>(callback: () => T | Promise<T>) {
  const keys = [
    'CODEX_OAUTH_AUTHORIZE_URL',
    'CODEX_OAUTH_CLIENT_ID',
    'CODEX_OAUTH_CLIENT_SECRET',
    'CODEX_OAUTH_COOKIE_SECRET',
    'CODEX_OAUTH_TOKEN_URL',
  ] as const
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof keys)[number], string | undefined>

  process.env.CODEX_OAUTH_AUTHORIZE_URL = 'https://auth.test/oauth/authorize'
  process.env.CODEX_OAUTH_CLIENT_ID = 'client_123'
  process.env.CODEX_OAUTH_CLIENT_SECRET = 'secret_123'
  process.env.CODEX_OAUTH_COOKIE_SECRET = 'test-secret'
  process.env.CODEX_OAUTH_TOKEN_URL = 'https://auth.test/oauth/token'

  try {
    return await callback()
  } finally {
    for (const key of keys) {
      const value = previous[key]

      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function buildRouteAuthCookieHeader() {
  const cloudflareToken = await sealCloudflareTokenCookieValue(
    { token: 'cf-token' },
    'test-secret',
  )

  return [
    await buildCodexRouteAuthCookieHeader(),
    `${cloudflareTokenCookie}=${cloudflareToken}`,
  ].join('; ')
}

async function buildCodexRouteAuthCookieHeader() {
  const codexToken = await sealCodexTokenCookieValue(
    {
      accessToken: 'codex-token',
      expiresAt: '2026-12-31T00:00:00.000Z',
    },
    'test-secret',
  )

  return `${codexOAuthTokenCookie}=${codexToken}`
}

function createCloudflareDeployRouteFetcher(workerName: string) {
  return (async (url: RequestInfo | URL) => {
    const href = String(url)

    if (href.endsWith('/user/tokens/verify')) {
      return Response.json({
        success: true,
        result: {
          policies: [
            {
              permission_groups: [{ name: 'Workers Scripts Write' }],
            },
          ],
        },
      })
    }

    if (href.endsWith('/accounts')) {
      return Response.json({
        success: true,
        result: [{ id: 'account_123', name: 'Acme Cloudflare' }],
      })
    }

    if (href.includes(`/workers/scripts/${workerName}`)) {
      return Response.json({
        success: true,
        result: { id: workerName },
      })
    }

    throw new Error(`Unexpected Cloudflare route fetch: ${href}`)
  }) as typeof fetch
}
