import { describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import {
  assertBuilderModelTranscriptWithinLimit,
  boundBuilderMessageForPersistence,
  loadBuilderTranscriptBinding,
  MAX_BUILDER_AGENT_MESSAGES,
  MAX_BUILDER_MODEL_TRANSCRIPT_BYTES,
  requireBuilderRequestScope,
  requireBuilderSeedTranscript,
  requireBuilderTranscriptIdentity,
  type BuilderTranscriptBinding,
} from './builder-request-policy';

const binding: BuilderTranscriptBinding = {
  agentName: 'chat--transcript-2-3',
  chatInitialId: 'chat',
  generation: 3,
  subchatIndex: 2,
};

describe('BuilderAgent request policy', () => {
  it('resolves the Agent name through its active owner-scoped transcript', async () => {
    const first = vi.fn(async () => ({
      agent_name: binding.agentName,
      initial_id: binding.chatInitialId,
      generation: binding.generation,
      subchat_index: binding.subchatIndex,
    }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn((_query: string) => ({ bind }));

    await expect(
      loadBuilderTranscriptBinding({ prepare } as unknown as D1Database, {
        agentName: binding.agentName,
        ownerId: 'owner',
      }),
    ).resolves.toEqual(binding);
    expect(bind).toHaveBeenCalledWith(binding.agentName, 'owner');
    expect(prepare.mock.calls[0]?.[0]).toContain('chats.is_deleted = 0');
  });

  it('accepts only an exact D1-bound chat, subchat, generation, and boolean', () => {
    expect(
      requireBuilderRequestScope(
        {
          chatInitialId: 'chat',
          shouldDisableTools: false,
          subchatIndex: 2,
          transcript: { agentName: binding.agentName, generation: 3, subchatIndex: 2 },
        },
        binding,
      ),
    ).toEqual({
      chatInitialId: 'chat',
      shouldDisableTools: false,
      subchatIndex: 2,
      transcript: { agentName: binding.agentName, generation: 3, subchatIndex: 2 },
    });
  });

  it.each([
    [{ chatInitialId: 'other-chat' }, 409],
    [{ shouldDisableTools: 'false' }, 400],
    [{ subchatIndex: 10_001 }, 400],
    [{ transcript: { agentName: binding.agentName, generation: 4, subchatIndex: 2 } }, 409],
    [{ transcript: { agentName: binding.agentName, generation: 3, subchatIndex: 1 } }, 409],
  ])('rejects mismatched or malformed scope fields: %o', (override, status) => {
    const action = () =>
      requireBuilderRequestScope(
        {
          chatInitialId: 'chat',
          shouldDisableTools: false,
          subchatIndex: 2,
          transcript: { agentName: binding.agentName, generation: 3, subchatIndex: 2 },
          ...override,
        },
        binding,
      );

    expect(action).toThrow(expect.objectContaining({ status }));
  });

  it('rejects transcript operations when no active D1 binding exists', () => {
    expect(() =>
      requireBuilderTranscriptIdentity({ agentName: binding.agentName, generation: 3, subchatIndex: 2 }, null),
    ).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('keeps the configured persisted transcript window finite', () => {
    expect(MAX_BUILDER_AGENT_MESSAGES).toBeGreaterThan(0);
    expect(MAX_BUILDER_AGENT_MESSAGES).toBeLessThanOrEqual(500);
  });

  it('bounds direct-client user text without altering assistant tool parts', () => {
    const user = boundBuilderMessageForPersistence({
      id: 'user',
      role: 'user',
      parts: [{ type: 'text', text: 'x'.repeat(40_000) }],
    });
    const assistant = {
      id: 'assistant',
      role: 'assistant' as const,
      parts: [
        {
          type: 'dynamic-tool' as const,
          toolName: 'write_file',
          toolCallId: 'call',
          state: 'input-available' as const,
          input: { content: 'x'.repeat(40_000) },
        },
      ],
    } satisfies UIMessage;

    expect(user.parts[0]).toMatchObject({ type: 'text', text: 'x'.repeat(32_000) });
    expect(boundBuilderMessageForPersistence(assistant)).toBe(assistant);
  });

  it('rejects a transcript above the pre-model byte budget', () => {
    expect(() => assertBuilderModelTranscriptWithinLimit(['x'.repeat(MAX_BUILDER_MODEL_TRANSCRIPT_BYTES)])).toThrow(
      expect.objectContaining({ status: 413 }),
    );
  });

  it('validates and bounds the aggregate seeded transcript before persistence', () => {
    const seed = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'welcome' }] },
    ];

    expect(requireBuilderSeedTranscript(seed)).toEqual(seed);
    expect(() =>
      requireBuilderSeedTranscript([
        {
          id: 'assistant-oversized',
          role: 'assistant',
          parts: [{ type: 'text', text: 'x'.repeat(MAX_BUILDER_MODEL_TRANSCRIPT_BYTES) }],
        },
      ]),
    ).toThrow(expect.objectContaining({ status: 413 }));
  });

  it.each([
    { name: 'missing identifier', messages: [{ role: 'user', parts: [] }] },
    { name: 'unexpected role', messages: [{ id: 'message', role: 'unexpected', parts: [] }] },
    { name: 'non-array parts', messages: [{ id: 'message', role: 'user', parts: null }] },
    { name: 'malformed part', messages: [{ id: 'message', role: 'user', parts: [null] }] },
    {
      name: 'duplicate identifiers',
      messages: [
        { id: 'duplicate', role: 'user', parts: [] },
        { id: 'duplicate', role: 'assistant', parts: [] },
      ],
    },
  ])('rejects $name before persistence', ({ messages }) => {
    expect(() => requireBuilderSeedTranscript(messages)).toThrow(expect.objectContaining({ status: 400 }));
  });
});
