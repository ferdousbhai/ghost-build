import { createFileRoute } from '@tanstack/react-router'
import { createDeployApprovalRecord } from '#/lib/deploy-approval'
import { assertStripeProjectsFundingReady } from '#/lib/stripe-projects'

export async function handleDeployApproval(request: Request) {
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

  try {
    await assertStripeProjectsFundingReady(request, Boolean(payload.hasPaidAction))
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Stripe Projects funding is required.',
        fundingRequired: true,
      },
      { status: 402 },
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
}

export const Route = createFileRoute('/api/deploy/approval')({
  server: {
    handlers: {
      POST: async ({ request }) => handleDeployApproval(request),
    },
  },
})
