import { describe, expect, it } from 'vitest'
import { buildAgentPlan } from './agent'

describe('buildAgentPlan', () => {
  it('creates a Cloudflare deployment plan from a plain-language idea', () => {
    const plan = buildAgentPlan({
      idea: 'A bakery preorder app',
      audience: 'bakery owner',
      deploymentTarget: 'Cloudflare Worker',
    })

    expect(plan.summary).toContain('A bakery preorder app')
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
      'OpenAI API key is stored only in the user browser',
    )
    expect(plan.defaults.paymentFlow).toContain(
      'Cloudflare and Stripe handle payment collection for paid infrastructure',
    )
    expect(plan.phases).toHaveLength(4)
  })
})
