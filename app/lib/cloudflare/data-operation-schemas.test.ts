import { describe, expect, it } from 'vitest';
import { dataOperationArgSchemas } from './data-operation-schemas';

describe('data operation argument bounds', () => {
  it('accepts a valid rewind position', () => {
    expect(
      dataOperationArgSchemas['messages.rewindChat'].safeParse({
        sessionId: 'user-1',
        chatId: 'chat-1',
        subchatIndex: 3,
        lastMessageRank: 12,
      }).success,
    ).toBe(true);
  });

  it.each([
    { subchatIndex: -1, lastMessageRank: 1 },
    { subchatIndex: 1.5, lastMessageRank: 1 },
    { subchatIndex: 10_001, lastMessageRank: 1 },
    { subchatIndex: 1, lastMessageRank: -1 },
    { subchatIndex: 1, lastMessageRank: 2.5 },
  ])('rejects an invalid rewind position: %o', (position) => {
    expect(
      dataOperationArgSchemas['messages.rewindChat'].safeParse({
        sessionId: 'user-1',
        chatId: 'chat-1',
        ...position,
      }).success,
    ).toBe(false);
  });

  it('rejects empty or oversized identifiers and descriptions', () => {
    expect(
      dataOperationArgSchemas['messages.setDescription'].safeParse({
        sessionId: '',
        id: 'chat-1',
        description: 'Title',
      }).success,
    ).toBe(false);
    expect(
      dataOperationArgSchemas['messages.initializeChat'].safeParse({
        sessionId: 'user-1',
        id: 'x'.repeat(513),
      }).success,
    ).toBe(false);
    expect(
      dataOperationArgSchemas['messages.setDescription'].safeParse({
        sessionId: 'user-1',
        id: 'chat-1',
        description: 'x'.repeat(201),
      }).success,
    ).toBe(false);
    expect(
      dataOperationArgSchemas['share.clone'].safeParse({
        sessionId: 'user-1',
        shareCode: '',
      }).success,
    ).toBe(false);
    expect(
      dataOperationArgSchemas['share.clone'].safeParse({
        sessionId: 'x'.repeat(513),
        shareCode: 'share-1',
      }).success,
    ).toBe(false);
  });

  it('accepts only bounded, exact pagination arguments', () => {
    expect(
      dataOperationArgSchemas['messages.getAll'].safeParse({
        sessionId: 'user-1',
        limit: 100,
        cursor: { timestamp: '2026-02-03T04:05:06.000Z', rowId: 'row-1' },
      }).success,
    ).toBe(true);
    expect(
      dataOperationArgSchemas['subchats.get'].safeParse({
        sessionId: 'user-1',
        chatId: 'chat-1',
        cursor: { subchatIndex: 10_000 },
      }).success,
    ).toBe(true);
    expect(
      dataOperationArgSchemas['subchats.get'].safeParse({
        sessionId: 'user-1',
        chatId: 'chat-1',
        cursor: { subchatIndex: 10_001 },
      }).success,
    ).toBe(false);

    for (const args of [
      { sessionId: 'user-1', limit: 101 },
      { sessionId: 'user-1', cursor: { timestamp: 'not-a-timestamp', rowId: 'row-1' } },
      { sessionId: 'user-1', cursor: { timestamp: '2026-02-03T06:05:06.000+02:00', rowId: 'row-1' } },
      {
        sessionId: 'user-1',
        cursor: { timestamp: '2026-02-03T04:05:06.000Z', rowId: 'row-1', unexpected: true },
      },
    ]) {
      expect(dataOperationArgSchemas['messages.getAll'].safeParse(args).success).toBe(false);
    }
  });
});
