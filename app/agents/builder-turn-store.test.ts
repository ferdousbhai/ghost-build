import { describe, expect, it } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { BuilderTurnStore, completeBuilderTurn, createBuilderTurn } from './builder-turn-store';

describe('BuilderTurnStore', () => {
  it('bounds identifiers, prompt previews, and terminal errors', () => {
    const turn = createBuilderTurn({
      requestId: 'r'.repeat(1_000),
      chatInitialId: 'c'.repeat(1_000),
      continuation: false,
      firstUserMessage: true,
      messages: [message('m', 'p'.repeat(1_000))],
    });
    const completed = completeBuilderTurn(turn, {
      status: 'error',
      requestId: 'n'.repeat(1_000),
      error: 'e'.repeat(4_000),
    });

    expect(turn.requestId).toHaveLength(512);
    expect(turn.chatInitialId).toHaveLength(512);
    expect(turn.lastUserMessagePreview).toHaveLength(500);
    expect(completed.requestId).toHaveLength(512);
    expect(completed.error).toHaveLength(2_000);
  });

  it('prunes old turn rows after every write', () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ text: strings.join('?'), values });
      return [];
    };
    const store = new BuilderTurnStore({ sql } as never);

    store.record(
      createBuilderTurn({
        requestId: 'request',
        chatInitialId: 'chat',
        continuation: false,
        firstUserMessage: true,
        messages: [message('m', 'hello')],
      }),
    );

    expect(statements).toHaveLength(2);
    expect(statements[1]?.text).toContain('LIMIT -1 OFFSET');
    expect(statements[1]?.values).toEqual([100]);
  });
});

function message(id: string, text: string): GhostbuildMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}
