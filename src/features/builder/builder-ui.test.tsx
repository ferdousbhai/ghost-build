// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAgentPlan, type AgentPlanRequest } from '#/lib/agent'
import type { CloudflareConnectionStatus } from '#/lib/cloudflare-status'
import type { CloudflareMcpStatus } from '#/lib/cloudflare-mcp'
import type { CodexAuthState } from '#/lib/model-auth'
import { initialAgentRequest } from './builderConstants'
import { IntroPanel } from './IntroPanel'
import { MessageList } from './MessageList'
import { PreviewPane } from './PreviewPane'
import { PromptComposer } from './PromptComposer'

afterEach(cleanup)

const disconnectedCodexAuth: CodexAuthState = {
  mode: 'chatgpt-codex-oauth',
  status: 'disconnected',
  recoveryUrl: '/api/codex-auth/start',
}

const connectedCodexAuth: CodexAuthState = {
  mode: 'chatgpt-codex-oauth',
  status: 'connected',
  account: {
    email: 'user@example.com',
    planType: 'plus',
  },
}

const connectedCloudflare: CloudflareConnectionStatus = {
  status: 'connected',
  accountId: 'account_123',
  accountName: 'Acme Cloudflare',
  permissions: ['Workers Scripts Write'],
  message: 'Connected to Acme Cloudflare.',
}

const authenticatingCloudflareMcp: CloudflareMcpStatus = {
  status: 'authenticating',
  message: 'Authorize Cloudflare API MCP to make Cloudflare tools available.',
  serverName: 'cloudflare-api',
  serverUrl: 'https://mcp.cloudflare.com/mcp',
  authUrl: 'https://dash.cloudflare.com/oauth/authorize',
  toolsCount: 0,
}

describe('builder UI gates', () => {
  it('keeps submit disabled until auth and prompt prerequisites are met', () => {
    render(
      <PromptComposer
        canSubmit={false}
        codexAuthState={disconnectedCodexAuth}
        hasCodexSignIn={false}
        hasStarted={false}
        isPending={false}
        model="gpt-5.5"
        reasoningEffort="low"
        prompt="Build a booking app"
        onPromptChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Run GhostBuild')).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByText(/Connect ChatGPT\/Codex/)).toBeTruthy()
  })

  it('disables existing-project import until real intake exists', () => {
    render(
      <IntroPanel
        codexAuthState={disconnectedCodexAuth}
        hasCodexSignIn={false}
        model="gpt-5.5"
        projectSource={initialAgentRequest.projectSource}
        reasoningEffort="low"
        goal={initialAgentRequest.goal}
        onGoalObjectiveChange={vi.fn()}
        onGoalSuccessCriteriaChange={vi.fn()}
        onProjectSourceChange={vi.fn()}
        onReasoningEffortChange={vi.fn()}
        onSelectSuggestion={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /Existing project/ })).toHaveProperty(
      'disabled',
      true,
    )
  })

  it('lets users edit the goal after a run starts', () => {
    const onGoalObjectiveChange = vi.fn()
    const onGoalSuccessCriteriaChange = vi.fn()

    render(
      <MessageList
        isPending={false}
        messages={[
          {
            role: 'assistant',
            title: 'GhostBuild',
            body: 'Plan ready',
          },
        ]}
        planReady
        goal={{
          objective: 'Build the first version',
          successCriteria: ['Preview works'],
        }}
        onGoalObjectiveChange={onGoalObjectiveChange}
        onGoalSuccessCriteriaChange={onGoalSuccessCriteriaChange}
      />,
    )

    fireEvent.change(screen.getByDisplayValue('Build the first version'), {
      target: { value: 'Build and deploy the first version' },
    })
    fireEvent.change(screen.getByDisplayValue('Preview works'), {
      target: { value: 'Preview works\nDeploy succeeds' },
    })

    expect(onGoalObjectiveChange).toHaveBeenCalledWith(
      'Build and deploy the first version',
    )
    expect(onGoalSuccessCriteriaChange).toHaveBeenCalledWith(
      'Preview works\nDeploy succeeds',
    )
  })

  it('keeps deploy confirmation disabled until Cloudflare is connected', () => {
    render(
      <PreviewPane
        cloudflareStatus={{
          status: 'missing-token',
          permissions: [],
          message: 'Set CLOUDFLARE_API_TOKEN to verify Cloudflare account access.',
        }}
        cloudflareMcpStatus={authenticatingCloudflareMcp}
        codexAuthState={connectedCodexAuth}
        isPending={false}
        plan={buildAgentPlan({ idea: 'A docs portal' })}
        onConnectCloudflareToken={vi.fn()}
        onConnectCloudflareMcp={vi.fn()}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={vi.fn()}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Deploy gated/ }))

    expect(screen.getByRole('button', { name: /Confirm deploy/ })).toHaveProperty(
      'disabled',
      true,
    )
  })

  it('surfaces Cloudflare MCP authorization without blocking the plan UI', () => {
    const onConnectCloudflareMcp = vi.fn()

    render(
      <PreviewPane
        cloudflareStatus={connectedCloudflare}
        cloudflareMcpStatus={authenticatingCloudflareMcp}
        codexAuthState={connectedCodexAuth}
        isPending={false}
        plan={buildAgentPlan({ idea: 'A docs portal' })}
        onConnectCloudflareToken={vi.fn()}
        onConnectCloudflareMcp={onConnectCloudflareMcp}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={vi.fn()}
        onRunBuildChecks={vi.fn()}
      />,
    )

    expect(screen.getByText('Authorization required')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open authorization/ }))
    expect(onConnectCloudflareMcp).toHaveBeenCalled()
  })

  it('keeps deploy confirmation disabled until Workers write permission is verified', () => {
    render(
      <PreviewPane
        cloudflareStatus={{
          status: 'connected',
          accountId: 'account_123',
          accountName: 'Acme Cloudflare',
          permissions: ['Workers Scripts Read'],
          message: 'Connected to Acme Cloudflare.',
        }}
        codexAuthState={connectedCodexAuth}
        isPending={false}
        plan={buildAgentPlan({ idea: 'A docs portal' })}
        onConnectCloudflareToken={vi.fn()}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={vi.fn()}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Deploy gated/ }))

    expect(screen.getByText('Workers write permission required before deploy')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Confirm deploy/ })).toHaveProperty(
      'disabled',
      true,
    )
  })

  it('calls the deploy approval flow after Cloudflare is connected', async () => {
    const onRequestDeployApproval = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        cloudflareStatus={connectedCloudflare}
        codexAuthState={connectedCodexAuth}
        isPending={false}
        plan={buildAgentPlan({
          idea: 'A docs portal',
        } satisfies Partial<AgentPlanRequest>)}
        onConnectCloudflareToken={vi.fn()}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={onRequestDeployApproval}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Deploy gated/ }))
    fireEvent.click(screen.getByRole('button', { name: /Confirm deploy/ }))

    expect(onRequestDeployApproval).toHaveBeenCalledWith({
      estimatedCost: 'No additional Cloudflare cost expected',
      hasDestructiveAction: false,
      hasPaidAction: false,
    })
  })

  it('captures paid and destructive deploy approval details', () => {
    const onRequestDeployApproval = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        cloudflareStatus={connectedCloudflare}
        codexAuthState={connectedCodexAuth}
        isPending={false}
        plan={buildAgentPlan({ idea: 'A paid docs portal' })}
        stripeProjectsStatus={{
          status: 'connected',
          message: 'Stripe Project connected for user-funded Cloudflare actions.',
          stripeProjectId: 'proj_123',
          connectedAt: '2026-05-12T00:00:00.000Z',
          defaultProviderSpendLimitUsd: 100,
        }}
        onConnectCloudflareToken={vi.fn()}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={onRequestDeployApproval}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Deploy gated/ }))
    fireEvent.change(screen.getByDisplayValue('No additional Cloudflare cost expected'), {
      target: { value: '$12/year domain' },
    })
    fireEvent.click(
      screen.getByLabelText('Includes paid Cloudflare action'),
    )
    fireEvent.click(
      screen.getByLabelText('Includes destructive Cloudflare action'),
    )
    fireEvent.click(screen.getByRole('button', { name: /Confirm deploy/ }))

    expect(onRequestDeployApproval).toHaveBeenCalledWith({
      estimatedCost: '$12/year domain',
      hasDestructiveAction: true,
      hasPaidAction: true,
    })
  })

  it('blocks paid deploy approval until Stripe Projects is connected', () => {
    const onRequestDeployApproval = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        cloudflareStatus={connectedCloudflare}
        codexAuthState={connectedCodexAuth}
        isPending={false}
        plan={buildAgentPlan({ idea: 'A paid docs portal' })}
        onConnectCloudflareToken={vi.fn()}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={onRequestDeployApproval}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Deploy gated/ }))
    fireEvent.click(screen.getByLabelText('Includes paid Cloudflare action'))
    fireEvent.click(screen.getByRole('button', { name: /Confirm deploy/ }))

    expect(onRequestDeployApproval).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        'Connect your own Stripe Project before approving paid Cloudflare actions.',
      ),
    ).toBeTruthy()
  })

  it('shows a Cloudflare token connection form when no account is connected', () => {
    const onConnectCloudflareToken = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        cloudflareStatus={{
          status: 'missing-token',
          permissions: [],
          message: 'Connect a Cloudflare API token.',
        }}
        codexAuthState={connectedCodexAuth}
        isPending={false}
        onConnectCloudflareToken={onConnectCloudflareToken}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={vi.fn()}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('Cloudflare API token'), {
      target: { value: 'cf-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(onConnectCloudflareToken).toHaveBeenCalledWith('cf-token')
  })

  it('calls the Worker file generation flow from the preview panel', () => {
    const onGenerateWorkerApp = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        cloudflareStatus={connectedCloudflare}
        codexAuthState={connectedCodexAuth}
        isPending={false}
        plan={buildAgentPlan({ idea: 'A generated portal' })}
        onConnectCloudflareToken={vi.fn()}
        onGenerateWorkerApp={onGenerateWorkerApp}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={vi.fn()}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Generate Worker files/ }))

    expect(onGenerateWorkerApp).toHaveBeenCalledTimes(1)
  })

  it('calls the build pipeline flow from the preview panel', () => {
    const onRunBuildPipeline = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        cloudflareStatus={connectedCloudflare}
        codexAuthState={connectedCodexAuth}
        isPending={false}
        plan={buildAgentPlan({ idea: 'A pipeline portal' })}
        onConnectCloudflareToken={vi.fn()}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={vi.fn()}
        onRunBuildPipeline={onRunBuildPipeline}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Run build pipeline/ }))

    expect(onRunBuildPipeline).toHaveBeenCalledTimes(1)
  })

  it('calls artifact checks after Worker files are generated', () => {
    const onRunBuildChecks = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        cloudflareStatus={connectedCloudflare}
        codexAuthState={connectedCodexAuth}
        generatedApp={{
          workerName: 'generated-portal',
          summary: 'Generated files',
          generatedAt: '2026-05-12T00:00:00.000Z',
          files: [{ path: 'wrangler.jsonc', content: '{}' }],
        }}
        isPending={false}
        plan={buildAgentPlan({ idea: 'A generated portal' })}
        onConnectCloudflareToken={vi.fn()}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={vi.fn()}
        onRunBuildChecks={onRunBuildChecks}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Run artifact checks/ }))

    expect(onRunBuildChecks).toHaveBeenCalledTimes(1)
  })

  it('calls preview preparation after artifact checks pass', () => {
    const onPrepareBuildPreview = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        checkResult={{
          status: 'passed',
          checkedAt: '2026-05-12T00:00:00.000Z',
          checks: [
            {
              name: 'wrangler.jsonc',
              status: 'passed',
              detail: 'wrangler.jsonc exists.',
            },
          ],
        }}
        cloudflareStatus={connectedCloudflare}
        codexAuthState={connectedCodexAuth}
        generatedApp={{
          workerName: 'generated-portal',
          summary: 'Generated files',
          generatedAt: '2026-05-12T00:00:00.000Z',
          files: [{ path: 'wrangler.jsonc', content: '{}' }],
        }}
        isPending={false}
        plan={buildAgentPlan({ idea: 'A generated portal' })}
        onConnectCloudflareToken={vi.fn()}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={onPrepareBuildPreview}
        onRequestDeployApproval={vi.fn()}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Prepare preview/ }))

    expect(onPrepareBuildPreview).toHaveBeenCalledTimes(1)
  })

  it('calls repair when artifact checks fail', () => {
    const onRepairGeneratedApp = vi.fn().mockResolvedValue(undefined)
    const onRequestAgentPatch = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        checkResult={{
          status: 'failed',
          checkedAt: '2026-05-12T00:00:00.000Z',
          checks: [
            {
              name: 'worker.js',
              status: 'failed',
              detail: 'worker.js is missing.',
            },
          ],
        }}
        cloudflareStatus={connectedCloudflare}
        codexAuthState={connectedCodexAuth}
        generatedApp={{
          workerName: 'generated-portal',
          summary: 'Generated files',
          generatedAt: '2026-05-12T00:00:00.000Z',
          files: [{ path: 'wrangler.jsonc', content: '{}' }],
        }}
        isPending={false}
        plan={buildAgentPlan({ idea: 'A generated portal' })}
        onConnectCloudflareToken={vi.fn()}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestAgentPatch={onRequestAgentPatch}
        onRepairGeneratedApp={onRepairGeneratedApp}
        onRequestDeployApproval={vi.fn()}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Ask agent to patch/ }))
    fireEvent.click(screen.getByRole('button', { name: /Repair generated files/ }))

    expect(onRequestAgentPatch).toHaveBeenCalledTimes(1)
    expect(onRepairGeneratedApp).toHaveBeenCalledTimes(1)
  })

  it('calls deploy after preview, checks, approval, and Cloudflare are ready', () => {
    const plan = buildAgentPlan({ idea: 'A deployable portal' })
    const onDeployWorkerApp = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        checkResult={{
          status: 'passed',
          checkedAt: '2026-05-12T00:00:00.000Z',
          checks: [
            {
              name: 'wrangler.jsonc',
              status: 'passed',
              detail: 'wrangler.jsonc exists.',
            },
          ],
        }}
        cloudflareStatus={connectedCloudflare}
        codexAuthState={connectedCodexAuth}
        deployApproval={{
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
        }}
        generatedApp={{
          workerName: plan.deployment.workerName,
          summary: 'Generated files',
          generatedAt: '2026-05-12T00:00:00.000Z',
          files: [{ path: 'wrangler.jsonc', content: '{}' }],
        }}
        isPending={false}
        plan={plan}
        preview={{
          status: 'ready',
          url: 'https://ghost.test/preview/a-deployable-portal',
          healthUrl: 'https://ghost.test/preview/a-deployable-portal/api/health',
          createdAt: '2026-05-12T00:00:00.000Z',
        }}
        onConnectCloudflareToken={vi.fn()}
        onDeployWorkerApp={onDeployWorkerApp}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={vi.fn()}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Deploy Worker/ }))

    expect(onDeployWorkerApp).toHaveBeenCalledTimes(1)
  })

  it('calls combined build and deploy after deploy approval is recorded', () => {
    const plan = buildAgentPlan({ idea: 'A pipeline deployable portal' })
    const onRunBuildDeployPipeline = vi.fn().mockResolvedValue(undefined)

    render(
      <PreviewPane
        cloudflareStatus={connectedCloudflare}
        codexAuthState={connectedCodexAuth}
        deployApproval={{
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
        }}
        isPending={false}
        plan={plan}
        onConnectCloudflareToken={vi.fn()}
        onGenerateWorkerApp={vi.fn()}
        onPrepareBuildPreview={vi.fn()}
        onRequestDeployApproval={vi.fn()}
        onRunBuildDeployPipeline={onRunBuildDeployPipeline}
        onRunBuildChecks={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Deploy gated/ }))
    fireEvent.click(screen.getByRole('button', { name: /Build and deploy/ }))

    expect(onRunBuildDeployPipeline).toHaveBeenCalledTimes(1)
  })
})
