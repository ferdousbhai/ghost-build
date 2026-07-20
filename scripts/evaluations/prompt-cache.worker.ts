const MODEL = '@cf/zai-org/glm-5.2';
const CACHEABLE_PREFIX = Array.from(
  { length: 1_000 },
  (_, index) => `Stable repository policy ${index}: inspect evidence, preserve correctness, and report concise facts.`,
).join('\n');

type EvaluationEnv = { AI: Ai };
type Usage = { inputTokens: number; cachedInputTokens?: number; outputTokens: number };

export default {
  async fetch(request: Request, env: EvaluationEnv): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('POST to run the Workers AI prefix-cache evaluation.', { status: 405 });
    }
    const runId = crypto.randomUUID();
    const affinity = `cache-eval-${runId}`;
    const coldWarmup = await generate(env.AI, CACHEABLE_PREFIX, affinity, 'Return only CACHE_WARMUP.');
    const coldControl = await generate(
      env.AI,
      `Control prefix ${runId}.\n${CACHEABLE_PREFIX}`,
      `cache-control-${runId}`,
      'Return only CACHE_CONTROL.',
    );
    const warm = await generate(env.AI, CACHEABLE_PREFIX, affinity, 'Return only CACHE_WARM.');

    return Response.json({
      model: MODEL,
      coldWarmup,
      coldControl,
      warm,
      correctnessPreserved: warm.text.includes('CACHE_WARM'),
      comparison: {
        latencyReductionPercent: reductionPercent(coldControl.durationMs, warm.durationMs),
        costReductionPercent: reductionPercent(estimatedCost(coldControl.usage), estimatedCost(warm.usage)),
      },
    });
  },
};

async function generate(ai: Ai, prefix: string, affinity: string, request: string) {
  const startedAt = Date.now();
  const response = (await ai.run(
    MODEL as never,
    {
      messages: [
        { role: 'system', content: `${prefix}\nFollow the final user request exactly.` },
        { role: 'user', content: request },
      ],
      max_tokens: 32,
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0,
    } as never,
    { extraHeaders: { 'x-session-affinity': affinity } },
  )) as unknown as {
    choices?: Array<{ message?: { content?: string } }>;
    response?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  const usage = {
    inputTokens: response.usage?.prompt_tokens ?? 0,
    cachedInputTokens: response.usage?.prompt_tokens_details?.cached_tokens,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
  return {
    text: response.response ?? response.choices?.[0]?.message?.content ?? '',
    durationMs: Date.now() - startedAt,
    usage,
    estimatedCostNanodollars: estimatedCost(usage),
  };
}

function estimatedCost(usage: Usage): number {
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0);
  return (usage.inputTokens - cached) * 1_400 + cached * 260 + usage.outputTokens * 4_400;
}

function reductionPercent(baseline: number, candidate: number): number {
  return baseline <= 0 ? 0 : Math.round((1 - candidate / baseline) * 10_000) / 100;
}
