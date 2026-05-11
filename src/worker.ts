import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'
import type { Register } from '@tanstack/react-router'
import type { RequestHandler } from '@tanstack/react-start/server'
import { routeAgentRequest } from 'agents'
import { GhostCoderAgent, type GhostCoderEnv } from './lib/ghost-agent'

export { GhostCoderAgent }

const startFetch = createStartHandler(defaultStreamHandler)

type ServerEntry = { fetch: RequestHandler<Register> }

function createServerEntry(entry: ServerEntry) {
  return {
    async fetch(request: Request, env: GhostCoderEnv, ctx: ExecutionContext) {
      const agentResponse = await routeAgentRequest(request, env)

      if (agentResponse) {
        return agentResponse
      }

      return (
        entry.fetch as unknown as (
          request: Request,
          env: GhostCoderEnv,
          ctx: ExecutionContext,
        ) => Promise<Response>
      )(request, env, ctx)
    },
  }
}

export default createServerEntry({ fetch: startFetch })
