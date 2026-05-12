import { createFileRoute } from '@tanstack/react-router'
import type { AgentPlan } from '#/lib/agent'
import { runGeneratedWorkerBuildDeployPipeline } from '#/lib/build-deploy-pipeline'
import {
  readCloudflareTokenFromRequest,
  verifyCloudflareConnectionFromRequest,
} from '#/lib/cloudflare-auth'
import { requireAppSession } from '#/lib/app-auth'
import type { DeployApprovalRecord } from '#/lib/deploy-approval'

export async function handleDeployRun(
  request: Request,
  fetcher: typeof fetch = fetch,
) {
  const auth = await requireAppSession(request)

        if (auth.response) {
          return auth.response
        }

  const payload = (await request.json().catch(() => ({}))) as {
    approval?: DeployApprovalRecord
    plan?: AgentPlan
  }

  if (!payload.plan) {
    return Response.json({ error: 'Plan is required to deploy.' }, {
      status: 400,
    })
  }

  try {
    return Response.json({
      pipeline: await runGeneratedWorkerBuildDeployPipeline({
        approval: payload.approval,
        cloudflareStatus: await verifyCloudflareConnectionFromRequest(
          request,
          fetcher,
        ),
        fetcher,
        origin: new URL(request.url).origin,
        plan: payload.plan,
        token: await readCloudflareTokenFromRequest(request),
      }),
    })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to run build and deploy pipeline.',
      },
      { status: 400 },
    )
  }
}

export const Route = createFileRoute('/api/deploy/run')({
  server: {
    handlers: {
      POST: async ({ request }) => handleDeployRun(request),
    },
  },
})
