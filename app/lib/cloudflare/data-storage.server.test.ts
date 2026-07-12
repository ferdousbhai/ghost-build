import { beforeEach, describe, expect, test, vi } from 'vitest';
import { storeChatAction } from './data.server';
import { updateStorageState } from './data/chat-repository.server';
import { deleteObject, putObject } from './data/object-storage.server';
import { sweepObjectGcCandidatesBestEffort } from './data/object-gc.server';

vi.mock('./data/auth.server', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  claimGuestSession: vi.fn(),
  getSessionId: vi.fn(),
  requireMatchingSession: vi.fn(),
}));
vi.mock('./data/chat-repository.server', () => ({
  findChat: vi.fn(),
  getLatestStorageState: vi.fn(),
  updateStorageState: vi.fn(),
}));
vi.mock('./data/object-storage.server', () => ({
  objectResponse: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
}));
vi.mock('./data/object-gc.server', () => ({
  sweepObjectGcCandidatesBestEffort: vi.fn(),
}));

const updateStorageStateMock = vi.mocked(updateStorageState);
const putObjectMock = vi.mocked(putObject);
const deleteObjectMock = vi.mocked(deleteObject);
const sweepObjectGcCandidatesBestEffortMock = vi.mocked(sweepObjectGcCandidatesBestEffort);

describe('chat blob ownership', () => {
  beforeEach(() => {
    updateStorageStateMock.mockReset();
    putObjectMock.mockReset();
    deleteObjectMock.mockReset();
    sweepObjectGcCandidatesBestEffortMock.mockReset();
  });

  test('deletes blobs rejected by a stale storage-state write', async () => {
    putObjectMock.mockResolvedValueOnce('message-key').mockResolvedValueOnce('snapshot-key');
    updateStorageStateMock.mockResolvedValue({
      retainedStorageKey: false,
      retainedSnapshotKey: false,
      displacedKeys: [],
    });

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(200);
    expect(deleteObjectMock.mock.calls.map(([, key]) => key)).toEqual(['message-key', 'snapshot-key']);
  });

  test('keeps blobs accepted by the storage-state write', async () => {
    putObjectMock.mockResolvedValueOnce('message-key').mockResolvedValueOnce('snapshot-key');
    updateStorageStateMock.mockResolvedValue({
      retainedStorageKey: true,
      retainedSnapshotKey: true,
      displacedKeys: [],
    });

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(200);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  test('defers displaced-key cleanup and runs a bounded opportunistic sweep', async () => {
    putObjectMock.mockResolvedValueOnce('message-key').mockResolvedValueOnce('snapshot-key');
    updateStorageStateMock.mockResolvedValue({
      retainedStorageKey: true,
      retainedSnapshotKey: true,
      displacedKeys: ['message-old', 'snapshot-old'],
    });
    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(200);
    expect(deleteObjectMock).not.toHaveBeenCalledWith(expect.anything(), 'message-old');
    expect(deleteObjectMock).not.toHaveBeenCalledWith(expect.anything(), 'snapshot-old');
    expect(sweepObjectGcCandidatesBestEffortMock).toHaveBeenCalledOnce();
  });

  test('deletes all uploaded blobs when the database update fails', async () => {
    putObjectMock.mockResolvedValueOnce('message-key').mockResolvedValueOnce('snapshot-key');
    updateStorageStateMock.mockRejectedValue(new Error('database unavailable'));

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(500);
    expect(deleteObjectMock.mock.calls.map(([, key]) => key)).toEqual(['message-key', 'snapshot-key']);
  });

  test('deletes the first blob when the second upload fails', async () => {
    putObjectMock.mockResolvedValueOnce('message-key').mockRejectedValueOnce(new Error('R2 unavailable'));

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(500);
    expect(deleteObjectMock.mock.calls.map(([, key]) => key)).toEqual(['message-key']);
    expect(updateStorageStateMock).not.toHaveBeenCalled();
  });

  test('does not fail a committed save when post-commit cleanup fails', async () => {
    putObjectMock.mockResolvedValueOnce('message-key').mockResolvedValueOnce('snapshot-key');
    updateStorageStateMock.mockResolvedValue({
      retainedStorageKey: false,
      retainedSnapshotKey: false,
      displacedKeys: [],
    });
    deleteObjectMock.mockRejectedValue(new Error('R2 cleanup unavailable'));

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(200);
    expect(deleteObjectMock).toHaveBeenCalledTimes(2);
  });
});

function storageRequest(): Request {
  const body = new FormData();
  body.set('messages', new Blob(['messages'], { type: 'application/json' }));
  body.set('snapshot', new Blob(['snapshot'], { type: 'application/octet-stream' }));
  return new Request(
    'https://ghostbuild.dev/api/chats/store?sessionId=session&chatId=chat&lastMessageRank=2&partIndex=1',
    { method: 'POST', body },
  );
}

function storageEnv(): Env {
  return { DB: {}, APP_STORAGE: {} } as Env;
}
