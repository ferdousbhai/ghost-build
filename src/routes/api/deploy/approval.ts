import { createFileRoute } from '@tanstack/react-router'
import { createDeployApprovalRecord } from '#/lib/deploy-approval'

export const Route = createFileRoute('/api/deploy/approval')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const payload = (await request.json().catch(() => ({}))) as Parameters<
          typeof createDeployApprovalRecord
        >[0]

        if (!payload.accountId || !payload.workerName || !payload.confirmedBy) {
          return Response.json(
            { error: 'Account, Worker name, and confirmer are required.' },
            { status: 400 },
          )
        }

        if (payload.hasPaidAction && !payload.estimatedCost?.trim()) {
          return Response.json(
            { error: 'Estimated cost is required for paid Cloudflare actions.' },
            { status: 400 },
          )
        }

        return Response.json({
          approval: createDeployApprovalRecord({
            ...payload,
            bindings: payload.bindings ?? [],
            hasPaidAction: Boolean(payload.hasPaidAction),
            hasDestructiveAction: Boolean(payload.hasDestructiveAction),
          }),
        })
      },
    },
  },
})
