const MODEL = '@cf/zai-org/glm-5.2';
const MAX_OUTPUT_TOKENS = 1_000;

type EvaluationEnv = { AI: Ai };
type Usage = { inputTokens: number; outputTokens: number };
type Generation = { text: string; durationMs: number; usage: Usage };

const fixtures = [
  {
    role: 'explorer',
    request: 'Find the likely cause of authenticated export URLs returning 404 and name the authoritative code path.',
    context: `
src/routes/export.ts: exportRoute calls lookupExport(session.accountId, params.slug).
src/data/export-repository.ts: lookupExport(ownerId, projectId) queries WHERE owner_id = ? AND project_id = ?.
src/routes/project.ts: project records expose both projectId and slug.
README.md: exports require authentication.
`,
    expected: ['src/routes/export.ts', 'lookupExport', 'slug', 'projectId|project ID|project_id'],
  },
  {
    role: 'explorer',
    request: 'Locate why restored chats can attach to the wrong branch after rewind.',
    context: `
app/history/restore.ts: loadSnapshot(chatId, subchatIndex) returns the newest object by timestamp.
app/history/identity.ts: TranscriptIdentity is agentName + subchatIndex + generation.
app/history/rewind.ts: rewind increments generation and writes a new head.
app/history/save.ts: object keys include chatId and subchatIndex but omit generation.
`,
    expected: ['generation', 'timestamp'],
  },
  {
    role: 'verifier',
    request: 'Review a proposed backup overwrite fix and identify the critical correctness checks.',
    context: `
backupSync(checkpoint): uploads only when localRevision > remoteRevision.
Remote writes accept expectedRevision and return 409 when the head changed.
Reload replaces local messages only after validating transcript identity.
Legacy backups have messages but no revision and are treated as revision zero.
`,
    expected: ['409', 'transcript identity', 'legacy', 'revision zero'],
  },
  {
    role: 'verifier',
    request: 'Review a repository search change for boundedness and stale-result safety.',
    context: `
searchText caps matches at 10,000 and returns 50 per page.
Each result includes a content-derived fileRevision.
Binary, generated, dependency, and build-output paths are excluded.
Callers must re-read the current range before editing when fileRevision changed.
`,
    expected: ['10,000', '50', 'fileRevision', 're-read'],
  },
] as const;

export default {
  async fetch(request: Request, env: EvaluationEnv): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('POST to run the bounded read-only sub-agent evaluation.', { status: 405 });
    }
    const requestedCase = Number(new URL(request.url).searchParams.get('case'));
    const selectedFixtures =
      Number.isInteger(requestedCase) && fixtures[requestedCase] ? [fixtures[requestedCase]] : fixtures;
    const cases = [];
    for (const fixture of selectedFixtures) {
      const parentPrompt = parentUserPrompt(fixture.request, fixture.context);
      const [baseline, child] = await Promise.all([
        generate(env.AI, parentPrompt, parentSystemPrompt()),
        generate(env.AI, childUserPrompt(fixture.request, fixture.context), childSystemPrompt(fixture.role)),
      ]);
      const assisted = await generate(
        env.AI,
        `${parentPrompt}\n\nRead-only ${fixture.role} advisory:\n${child.text}`,
        parentSystemPrompt(),
      );
      cases.push({
        role: fixture.role,
        baseline: score(baseline, fixture.expected),
        assisted: score(
          {
            text: assisted.text,
            durationMs: child.durationMs + assisted.durationMs,
            usage: addUsage(child.usage, assisted.usage),
          },
          fixture.expected,
        ),
      });
    }
    return Response.json({ model: MODEL, cases, summary: summarize(cases) });
  },
};

async function generate(ai: Ai, prompt: string, system: string): Promise<Generation> {
  const startedAt = Date.now();
  const raw = (await ai.run(
    MODEL as never,
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      reasoning_effort: 'low',
      temperature: 0.1,
    } as never,
  )) as unknown;
  const result = raw as {
    response?: string;
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
  };
  const message = result.choices?.[0]?.message;
  const text = result.response ?? message?.content ?? message?.reasoning_content ?? '';
  if (!text.trim()) {
    throw new Error('Workers AI exhausted its evaluation output budget before returning text.');
  }
  return {
    text,
    durationMs: Date.now() - startedAt,
    usage: {
      inputTokens: result.usage?.input_tokens ?? result.usage?.prompt_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? result.usage?.completion_tokens ?? 0,
    },
  };
}

function score(generation: Generation, expected: readonly string[]) {
  const lower = generation.text.toLowerCase();
  const missing = expected.filter((marker) =>
    marker.split('|').every((alternative) => !lower.includes(alternative.toLowerCase())),
  );
  return {
    success: missing.length === 0,
    missing,
    durationMs: generation.durationMs,
    ...generation.usage,
    costNanodollars: generation.usage.inputTokens * 1_400 + generation.usage.outputTokens * 4_400,
    outputPreview: generation.text.slice(0, 500),
  };
}

function summarize(cases: Array<{ baseline: ReturnType<typeof score>; assisted: ReturnType<typeof score> }>) {
  const aggregate = (variant: 'baseline' | 'assisted') => ({
    successes: cases.filter((entry) => entry[variant].success).length,
    cases: cases.length,
    durationMs: cases.reduce((total, entry) => total + entry[variant].durationMs, 0),
    inputTokens: cases.reduce((total, entry) => total + entry[variant].inputTokens, 0),
    outputTokens: cases.reduce((total, entry) => total + entry[variant].outputTokens, 0),
    costNanodollars: cases.reduce((total, entry) => total + entry[variant].costNanodollars, 0),
  });
  return { baseline: aggregate('baseline'), assisted: aggregate('assisted') };
}

function addUsage(left: Usage, right: Usage): Usage {
  return { inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens };
}

function parentSystemPrompt(): string {
  return 'Act as the primary software-building agent. Give a concise factual answer using only the supplied workspace data.';
}

function childSystemPrompt(role: string): string {
  return `Act as a read-only ${role} child. You have no tools. Return a concise factual advisory for the parent.`;
}

function parentUserPrompt(request: string, context: string): string {
  return `Request:\n${request}\n\nWorkspace data:\n${context}`;
}

function childUserPrompt(request: string, context: string): string {
  return `Parent request:\n${request}\n\nBounded workspace data:\n${context}`;
}
