import { describe, expect, it } from 'vitest';
import { PiSteeringQueue } from './pi-steering';

describe('PiSteeringQueue', () => {
  it('delivers committed steering messages one at a time with ephemeral context', async () => {
    const queue = new PiSteeringQueue();
    const first = queue.reserve(message('first'), { version: 1, content: 'Changed: src/app.ts' });
    const second = queue.reserve(message('second'));
    first?.commit();
    second?.commit();

    await expect(queue.drain()).resolves.toEqual([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Changed: src/app.ts') }),
    ]);
    await expect(queue.drain()).resolves.toEqual([expect.objectContaining({ role: 'user', content: 'second' })]);
    await expect(queue.drain()).resolves.toEqual([]);
  });

  it('waits for persistence before exposing a reserved message and closes admission on settlement', async () => {
    const queue = new PiSteeringQueue();
    const reservation = queue.reserve(message('persist me'));
    let settled = false;
    const draining = queue.drain().then((messages) => {
      settled = true;
      return messages;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    reservation?.commit();
    await expect(draining).resolves.toHaveLength(1);

    queue.close();
    expect(queue.reserve(message('late'))).toBeNull();
  });
});

function message(text: string) {
  return { id: text, role: 'user' as const, parts: [{ type: 'text' as const, text }] };
}
