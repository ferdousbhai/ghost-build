import { describe, expect, test, vi } from 'vitest';
import { withResolvers } from '~/utils/promises';
import { ToolExecutionScheduler } from './tool-execution-scheduler';

describe('ToolExecutionScheduler', () => {
  test('overlaps read-only tools and holds mutations behind a barrier', async () => {
    const scheduler = new ToolExecutionScheduler();
    const firstRead = withResolvers<void>();
    const secondRead = withResolvers<void>();
    const events: string[] = [];
    const readOne = scheduler.run('view', async () => {
      events.push('read-one-start');
      await firstRead.promise;
      events.push('read-one-end');
    });
    const readTwo = scheduler.run('searchText', async () => {
      events.push('read-two-start');
      await secondRead.promise;
      events.push('read-two-end');
    });
    await vi.waitFor(() => expect(events).toEqual(['read-one-start', 'read-two-start']));

    const mutation = scheduler.run('writeFile', async () => {
      events.push('mutation');
    });
    await Promise.resolve();
    expect(events).not.toContain('mutation');
    firstRead.resolve();
    secondRead.resolve();
    await Promise.all([readOne, readTwo, mutation]);
    expect(events.at(-1)).toBe('mutation');
  });

  test('does not allow new reads to pass a queued mutation', async () => {
    const scheduler = new ToolExecutionScheduler();
    const releaseMutation = withResolvers<void>();
    const events: string[] = [];
    const mutation = scheduler.run('edit', async () => {
      events.push('mutation-start');
      await releaseMutation.promise;
      events.push('mutation-end');
    });
    const read = scheduler.run('view', async () => {
      events.push('read');
    });
    await vi.waitFor(() => expect(events).toEqual(['mutation-start']));
    releaseMutation.resolve();
    await Promise.all([mutation, read]);
    expect(events).toEqual(['mutation-start', 'mutation-end', 'read']);
  });

  test('releases the barrier after an overlapping read fails', async () => {
    const scheduler = new ToolExecutionScheduler();
    const releaseRead = withResolvers<void>();
    const failedRead = scheduler.run('view', async () => {
      await releaseRead.promise;
      throw new Error('read failed');
    });
    const mutation = scheduler.run('writeFile', async () => 'mutation completed');
    releaseRead.resolve();

    await expect(failedRead).rejects.toThrow('read failed');
    await expect(mutation).resolves.toBe('mutation completed');
    await expect(scheduler.run('view', async () => 'next read completed')).resolves.toBe('next read completed');
  });
});
