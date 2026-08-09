import { describe, expect, it, vi } from 'vitest';
import { Type, type Message } from '@earendil-works/pi-ai';
import { getPiModel, type ModelStreamOptions } from './pi-ai-models';

describe('Pi Workers AI model binding', () => {
  it('routes OpenAI-compatible requests through env.AI.run without external credentials', async () => {
    const modelId = '@cf/zai-org/glm-5.2';
    const run = vi.fn(
      async () =>
        new Response(
          [
            `data: ${JSON.stringify({
              id: 'completion-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: modelId,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            })}`,
            `data: ${JSON.stringify({
              id: 'completion-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: modelId,
              choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
            })}`,
            `data: ${JSON.stringify({
              id: 'completion-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: modelId,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}`,
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const handle = getPiModel({ binding: { run } as unknown as Ai }, modelId, {
      sessionAffinity: 'opaque-session',
    });
    const messages: Message[] = [{ role: 'user', content: 'Hi', timestamp: 1 }];

    const result = await handle
      .stream(
        handle.model,
        {
          messages,
          tools: [
            {
              name: 'write',
              description: 'Write a project file.',
              parameters: Type.Object({ path: Type.String(), content: Type.String() }),
            },
          ],
        },
        { thinking: false, toolChoice: 'required' } as ModelStreamOptions & { toolChoice: 'required' },
      )
      .result();

    expect(result.content).toContainEqual({ type: 'text', text: 'Hello' });
    expect(run).toHaveBeenCalledWith(
      modelId,
      expect.objectContaining({
        messages: expect.any(Array),
        stream: true,
        tool_choice: 'required',
        tools: expect.any(Array),
      }),
      expect.objectContaining({
        returnRawResponse: true,
        signal: expect.any(AbortSignal),
        extraHeaders: { 'x-session-affinity': 'opaque-session' },
      }),
    );
  });
});
