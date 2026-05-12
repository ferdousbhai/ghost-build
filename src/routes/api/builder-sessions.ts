import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { getAgentByName } from 'agents'
import {
  ownerIdFromAppSession,
  requireAppSession,
} from '#/lib/app-auth'
import type { BuilderSessionSnapshot } from '#/lib/builder-session-store'
import { GhostBuildAgent, type GhostBuildEnv } from '#/lib/ghost-agent'

export const Route = createFileRoute('/api/builder-sessions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAppSession(request)

        if (auth.response) {
          return auth.response
        }

        const ownerId = ownerIdFromAppSession(auth.session)
        const agent = await getBuilderSessionAgent(ownerId)
        const sessionId = new URL(request.url).searchParams.get('sessionId')

        if (sessionId) {
          const session = await agent.getBuilderSessionSnapshot(ownerId, sessionId)

          if (!session) {
            return Response.json(
              { error: 'Builder session was not found.' },
              { status: 404 },
            )
          }

          return Response.json({
            latest: session,
            sessions: await agent.listBuilderSessionSummaries(ownerId),
          })
        }

        const sessions = await agent.listBuilderSessionSnapshots(ownerId)

        return Response.json({
          latest: sessions[0],
          sessions: await agent.listBuilderSessionSummaries(ownerId),
        })
      },
      POST: async ({ request }) => {
        const auth = await requireAppSession(request)

        if (auth.response) {
          return auth.response
        }

        const ownerId = ownerIdFromAppSession(auth.session)
        const payload = (await request.json().catch(() => ({}))) as Partial<
          BuilderSessionSnapshot
        >

        if (!payload.request || !payload.plan || !payload.submittedPrompt) {
          return Response.json(
            { error: 'Builder session request, plan, and prompt are required.' },
            { status: 400 },
          )
        }

        const snapshot: BuilderSessionSnapshot = {
          ownerId,
          request: payload.request,
          plan: payload.plan,
          submittedPrompt: payload.submittedPrompt,
          goalTimeline: payload.goalTimeline ?? [],
          checkResult: payload.checkResult,
          deployApproval: payload.deployApproval,
          deployResult: payload.deployResult,
          generatedApp: payload.generatedApp,
          preview: payload.preview,
          updatedAt: new Date().toISOString(),
        }

        const agent = await getBuilderSessionAgent(ownerId)

        return Response.json({
          session: await agent.saveBuilderSessionSnapshot(snapshot),
        })
      },
    },
  },
})

async function getBuilderSessionAgent(ownerId: string) {
  return getAgentByName<GhostBuildEnv, GhostBuildAgent>(
    (env as GhostBuildEnv).GhostBuildAgent,
    `builder-sessions-${ownerId}`,
  )
}
