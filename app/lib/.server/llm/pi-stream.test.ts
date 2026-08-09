import { describe, expect, it } from 'vitest';
import type { PiStreamChunk } from './pi-stream';
import { createPiStreamResponse } from './pi-stream';

describe('createPiStreamResponse', () => {
  it('uses the AI SDK SSE wire protocol expected by the chat client', async () => {
    const response = createPiStreamResponse(
      new ReadableStream<PiStreamChunk>({
        start(controller) {
          controller.enqueue({ type: 'start' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    );

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    await expect(response.text()).resolves.toBe(
      'data: {"type":"start"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n',
    );
  });
});
