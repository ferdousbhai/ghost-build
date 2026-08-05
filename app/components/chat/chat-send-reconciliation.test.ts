import { describe, expect, it } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { advanceTranscriptCheckpoint } from 'ghostbuild-agent/transcript';
import { reconcileMessagesForSend } from './chat-send-reconciliation';

describe('reconcileMessagesForSend', () => {
  it('keeps local messages that match the durable checkpoint', async () => {
    const localMessages = [message('local')];
    const checkpoint = await advanceTranscriptCheckpoint(null, identity, localMessages);

    expect(
      await reconcileMessagesForSend({
        durableCheckpoint: checkpoint,
        localMessages,
        loadedCheckpoint: null,
        loadedMessages: [],
      }),
    ).toBe(localMessages);
  });

  it('adopts authoritative refreshed messages when local hydration is stale', async () => {
    const loadedMessages = [message('durable')];
    const checkpoint = await advanceTranscriptCheckpoint(null, identity, loadedMessages);

    expect(
      await reconcileMessagesForSend({
        durableCheckpoint: checkpoint,
        localMessages: [],
        loadedCheckpoint: checkpoint,
        loadedMessages,
      }),
    ).toBe(loadedMessages);
  });

  it('rejects when neither local nor refreshed messages match durable state', async () => {
    const durableMessages = [message('durable')];
    const checkpoint = await advanceTranscriptCheckpoint(null, identity, durableMessages);

    expect(
      await reconcileMessagesForSend({
        durableCheckpoint: checkpoint,
        localMessages: [],
        loadedCheckpoint: checkpoint,
        loadedMessages: [message('stale')],
      }),
    ).toBeNull();
  });

  it('rejects refreshed messages whose checkpoint is older than durable state', async () => {
    const firstMessages = [message('first')];
    const firstCheckpoint = await advanceTranscriptCheckpoint(null, identity, firstMessages);
    const durableMessages = [...firstMessages, message('second')];
    const durableCheckpoint = await advanceTranscriptCheckpoint(firstCheckpoint, identity, durableMessages);

    expect(
      await reconcileMessagesForSend({
        durableCheckpoint,
        localMessages: [],
        loadedCheckpoint: firstCheckpoint,
        loadedMessages: firstMessages,
      }),
    ).toBeNull();
  });
});

const identity = { agentName: 'agent', generation: 0, subchatIndex: 0 } as const;

function message(id: string): GhostbuildMessage {
  return { id, role: 'user', parts: [{ type: 'text', text: id }] };
}
