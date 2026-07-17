import { beforeEach, describe, expect, test, vi } from 'vitest';
import { initialMessagesAction, storeChatAction } from './data.server';
import { getLatestStorageStateForGeneration, updateStorageState } from './data/chat-repository.server';
import { deleteObject, objectResponse, putObject } from './data/object-storage.server';
import { sweepObjectGcCandidatesBestEffort } from './data/object-gc.server';

const checkpoint = {
  agentName: 'chat',
  generation: 0,
  subchatIndex: 0,
  revision: 1,
  digest: 'a'.repeat(64),
  messageCount: 3,
};

vi.mock('./data/auth.server', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  claimGuestSession: vi.fn(),
  getSessionId: vi.fn(),
  requireMatchingSession: vi.fn(),
}));
vi.mock('./data/chat-repository.server', () => ({
  findChat: vi.fn(() => Promise.resolve({ id: 'chat-row', initial_id: 'chat' })),
  getLatestStorageState: vi.fn(),
  getLatestStorageStateForGeneration: vi.fn(),
  updateStorageState: vi.fn(),
}));
vi.mock('./data/transcript-repository.server', () => ({
  requireChatTranscript: vi.fn(() =>
    Promise.resolve({ chat_id: 'chat-row', subchat_index: 0, generation: 0, agent_name: 'chat' }),
  ),
  transcriptIdentity: (row: { agent_name: string; generation: number; subchat_index: number }) => ({
    agentName: row.agent_name,
    generation: row.generation,
    subchatIndex: row.subchat_index,
  }),
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
const getLatestStorageStateMock = vi.mocked(getLatestStorageStateForGeneration);
const putObjectMock = vi.mocked(putObject);
const deleteObjectMock = vi.mocked(deleteObject);
const objectResponseMock = vi.mocked(objectResponse);
const sweepObjectGcCandidatesBestEffortMock = vi.mocked(sweepObjectGcCandidatesBestEffort);

describe('chat blob ownership', () => {
  beforeEach(() => {
    updateStorageStateMock.mockReset();
    putObjectMock.mockReset();
    deleteObjectMock.mockReset();
    getLatestStorageStateMock.mockReset();
    objectResponseMock.mockReset();
    sweepObjectGcCandidatesBestEffortMock.mockReset();
  });

  test('deletes blobs rejected by a stale storage-state write', async () => {
    putObjectMock.mockResolvedValueOnce('message-key').mockResolvedValueOnce('snapshot-key');
    updateStorageStateMock.mockResolvedValue({
      accepted: false,
      retainedStorageKey: false,
      retainedSnapshotKey: false,
      displacedKeys: [],
    });

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(409);
    expect(deleteObjectMock.mock.calls.map(([, key]) => key)).toEqual(['message-key', 'snapshot-key']);
  });

  test('keeps blobs accepted by the storage-state write', async () => {
    putObjectMock.mockResolvedValueOnce('message-key').mockResolvedValueOnce('snapshot-key');
    updateStorageStateMock.mockResolvedValue({
      accepted: true,
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
      accepted: true,
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

  test('rejects a stale transcript before uploading any blobs', async () => {
    const advanced = { ...checkpoint, revision: 2, digest: 'b'.repeat(64), messageCount: 4 };

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv(advanced) });

    expect(response.status).toBe(409);
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(updateStorageStateMock).not.toHaveBeenCalled();
  });

  test('deletes uploaded blobs when the transcript advances during upload', async () => {
    const advanced = { ...checkpoint, revision: 2, digest: 'b'.repeat(64), messageCount: 4 };
    putObjectMock.mockResolvedValueOnce('message-key').mockResolvedValueOnce('snapshot-key');

    const response = await storeChatAction({
      request: storageRequest(),
      env: storageEnv(checkpoint, advanced),
    });

    expect(response.status).toBe(409);
    expect(deleteObjectMock.mock.calls.map(([, key]) => key)).toEqual(['message-key', 'snapshot-key']);
    expect(updateStorageStateMock).not.toHaveBeenCalled();
  });

  test('does not fail a committed save when post-commit cleanup fails', async () => {
    putObjectMock.mockResolvedValueOnce('message-key').mockResolvedValueOnce('snapshot-key');
    updateStorageStateMock.mockResolvedValue({
      accepted: true,
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

describe('chat transcript reload', () => {
  beforeEach(() => {
    getLatestStorageStateMock.mockReset();
    objectResponseMock.mockReset();
  });

  test('prefers the authoritative Durable Object transcript', async () => {
    const messages = [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }];
    getLatestStorageStateMock.mockResolvedValue({ storage_key: 'history-key' } as never);

    const response = await initialMessagesAction({
      request: initialMessagesRequest(),
      env: storageEnvWithSnapshots(checkpointWithMessages(checkpoint, messages)),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 2, transcript: checkpoint, messages });
    expect(objectResponseMock).not.toHaveBeenCalled();
  });

  test('uses the materialized R2 history to seed an empty transcript generation', async () => {
    getLatestStorageStateMock.mockResolvedValue({ storage_key: 'history-key' } as never);
    objectResponseMock.mockResolvedValue(new Response('compressed-history'));

    const response = await initialMessagesAction({
      request: initialMessagesRequest(),
      env: storageEnvWithSnapshots({ checkpoint: null, messages: [] }),
    });

    expect(await response.text()).toBe('compressed-history');
    expect(objectResponseMock).toHaveBeenCalledWith(expect.anything(), 'history-key');
  });
});

function storageRequest(): Request {
  const body = new FormData();
  body.set('messages', new Blob(['messages'], { type: 'application/json' }));
  body.set('snapshot', new Blob(['snapshot'], { type: 'application/octet-stream' }));
  return new Request(
    `https://ghostbuild.dev/api/chats/store?sessionId=session&chatId=chat&lastMessageRank=2&partIndex=1&transcriptAgentName=chat&transcriptGeneration=0&transcriptRevision=1&transcriptDigest=${checkpoint.digest}&transcriptMessageCount=3`,
    { method: 'POST', body },
  );
}

function initialMessagesRequest(): Request {
  return new Request('https://ghostbuild.dev/api/chats/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session', chatId: 'chat', subchatIndex: 0 }),
  });
}

function checkpointWithMessages(current: typeof checkpoint, messages: unknown[]) {
  return { checkpoint: current, messages };
}

function storageEnv(...durableCheckpoints: Array<typeof checkpoint>): Env {
  const snapshots = durableCheckpoints.map((current) => checkpointWithMessages(current, []));
  return storageEnvWithSnapshots(...snapshots);
}

function storageEnvWithSnapshots(
  ...snapshots: Array<{ checkpoint: typeof checkpoint | null; messages: unknown[] }>
): Env {
  let call = 0;
  return {
    DB: {},
    APP_STORAGE: {},
    BuilderAgent: {
      getByName: () => ({
        getTranscriptSnapshot: async () =>
          snapshots[Math.min(call++, snapshots.length - 1)] ?? {
            checkpoint,
            messages: [],
          },
      }),
    },
  } as unknown as Env;
}
