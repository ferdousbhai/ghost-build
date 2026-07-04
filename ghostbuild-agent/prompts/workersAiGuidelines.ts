import { stripIndents } from '../utils/stripIndent.js';

export function workersAiGuidelines() {
  return stripIndents`
  <workers_ai_guidelines>
    Apps in the Ghostbuild environment should use Cloudflare Workers AI for bundled AI features.

    The template provides an \`AI\` binding in \`wrangler.jsonc\`, a shared model helper in
    \`src/workers-ai.shared.ts\`, and an \`AIChatAgent\` in \`src/agents/app-agent.ts\`.
    For chat UI, use \`useAgentChat\` from \`@cloudflare/ai-chat/react\` against that Agent instead of
    adding custom \`/api/ai\` fetch endpoints. Keep the Agent transcript durable, but call
    \`pruneMessages\` on model messages before \`streamText\` so old reasoning/tool context does not grow without bound.
    Set \`maxPersistedMessages\` on \`AIChatAgent\` classes to bound SQLite transcript storage, and pass
    \`options?.abortSignal\` through to \`streamText\` so stopped chat requests cancel Workers AI calls.
    Set \`messageConcurrency = "queue"\` for deterministic chat turn ordering unless the app intentionally needs latest,
    merge, drop, or debounce behavior. Set \`waitForMcpConnections = { timeout: 10_000 }\` when an Agent may use MCP tools
    so startup waits are explicit instead of relying on package defaults.
    Set \`static override options = { sendIdentityOnConnect: false }\` on Agent classes when instance names can contain
    chat IDs, user IDs, or session IDs, and use state updates rather than \`agent.identified\` as the readiness signal.
    For direct non-chat Worker calls, use:

    \`\`\`ts
    const result = await env.AI.run("@cf/zai-org/glm-5.2", {
      messages: [
        { role: "system", content: "You are a helpful coding agent." },
        { role: "user", content: prompt },
      ],
    });
    \`\`\`

    The default AI/coding-agent model is \`@cf/zai-org/glm-5.2\`.
    Do not add third-party AI provider clients or non-Cloudflare AI endpoints for AI features.
  </workers_ai_guidelines>
  `;
}
