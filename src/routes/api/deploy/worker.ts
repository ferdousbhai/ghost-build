import { createFileRoute } from '@tanstack/react-router'
import type { AgentPlan } from '#/lib/agent'
import type { BuildCheckResult } from '#/lib/build-checks'
import type { BuildPreviewResult } from '#/lib/build-preview'
import { deployGeneratedWorkerApp } from '#/lib/cloudflare-deploy'
import {
  readCloudflareTokenFromRequest,
  verifyCloudflareConnectionFromRequest,
} from '#/lib/cloudflare-auth'
import { requireAppSession } from '#/lib/app-auth'
import type { DeployApprovalRecord } from '#/lib/deploy-approval'
import type { GeneratedWorkerApp } from '#/lib/generated-worker-app'

export async function handleDeployWorker(
  request: Request,
  fetcher: typeof fetch = fetch,
) {
  const auth = await requireAppSession(request)

        if (auth.response) {
          return auth.response
        }

  const payload = (await request.json().catch(() => ({}))) as {
    approval?: DeployApprovalRecord
    checkResult?: BuildCheckResult
    generatedApp?: GeneratedWorkerApp
    plan?: AgentPlan
    preview?: BuildPreviewResult
  }

  if (!payload.plan) {
    return Response.json({ error: 'Plan is required to deploy.' }, {
      status: 400,
    })
  }

  try {
    const token = await readCloudflareTokenFromRequest(request)

    return Response.json({
      deployResult: await deployGeneratedWorkerApp({
        approval: payload.approval,
        checkResult: payload.checkResult,
        cloudflareStatus: await verifyCloudflareConnectionFromRequest(
          request,
          fetcher,
        ),
        generatedApp: payload.generatedApp,
        plan: payload.plan,
        preview: payload.preview,
        token,
        fetcher,
      }),
    })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to deploy Worker.',
      },
      { status: 400 },
    )
  }
}

export const Route = createFileRoute('/api/deploy/worker')({
  server: {
    handlers: {
      POST: async ({ request }) => handleDeployWorker(request),
    },
  },
})
