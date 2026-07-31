import { beforeEach, describe, expect, test, vi } from 'vitest';
import { initialMessagesAction, storageObjectAction, storeChatAction, uploadThumbnailAction } from './data.server';
import {
  enforceChatStorageRetention,
  findChat,
  getLatestStorageStateForGeneration,
  updateStorageState,
} from './data/chat-repository.server';
import { ChatStorageRetentionError } from './data/errors';
import { allocateCustomerObjectKey, objectResponse, putObjectAtKey } from './data/object-storage.server';
import {
  cancelObjectGcCandidate,
  queueObjectGcCandidate,
  sweepObjectGcCandidatesBestEffort,
} from './data/object-gc.server';
import {
  admitChatBackupRequest,
  ChatBackupQuotaError,
  completeChatBackupAdmission,
  enforceChatBackupEdgeRateLimit,
  registerChatBackupObject,
  releaseChatBackupAdmissionBestEffort,
  reserveChatBackupBytes,
} from './data/chat-backup-quota.server';
import { MESSAGE_HISTORY_LZ4_LIMITS, PROJECT_SNAPSHOT_LZ4_LIMITS } from '~/lib/compression-limits';
import {
  admitThumbnailUpload,
  releaseThumbnailAdmissionBestEffort,
  ThumbnailQuotaError,
} from './data/thumbnail-quota.server';
import { saveThumbnail } from './data/share-service.server';

const getAuthSession = vi.hoisted(() => vi.fn());

vi.mock('~/lib/.server/auth', () => ({ getAuthSession }));

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
  enforceChatStorageRetention: vi.fn(),
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
  allocateCustomerObjectKey: vi.fn(),
  objectResponse: vi.fn(),
  putObjectAtKey: vi.fn(),
}));
vi.mock('./data/object-gc.server', () => ({
  cancelObjectGcCandidate: vi.fn(),
  queueObjectGcCandidate: vi.fn(),
  sweepObjectGcCandidatesBestEffort: vi.fn(),
}));
vi.mock('./data/chat-backup-quota.server', async () => {
  const actual = await vi.importActual('./data/chat-backup-quota.server');
  return {
    ...actual,
    admitChatBackupRequest: vi.fn(),
    completeChatBackupAdmission: vi.fn(),
    enforceChatBackupEdgeRateLimit: vi.fn(),
    registerChatBackupObject: vi.fn(),
    releaseChatBackupAdmissionBestEffort: vi.fn(),
    reserveChatBackupBytes: vi.fn(),
  };
});
vi.mock('./data/thumbnail-quota.server', async () => {
  const actual = await vi.importActual('./data/thumbnail-quota.server');
  return {
    ...actual,
    admitThumbnailUpload: vi.fn(),
    releaseThumbnailAdmissionBestEffort: vi.fn(),
  };
});
vi.mock('./data/share-service.server', async () => {
  const actual = await vi.importActual('./data/share-service.server');
  return { ...actual, saveThumbnail: vi.fn() };
});

const updateStorageStateMock = vi.mocked(updateStorageState);
const findChatMock = vi.mocked(findChat);
const getLatestStorageStateMock = vi.mocked(getLatestStorageStateForGeneration);
const enforceChatStorageRetentionMock = vi.mocked(enforceChatStorageRetention);
const allocateCustomerObjectKeyMock = vi.mocked(allocateCustomerObjectKey);
const putObjectAtKeyMock = vi.mocked(putObjectAtKey);
const queueObjectGcCandidateMock = vi.mocked(queueObjectGcCandidate);
const cancelObjectGcCandidateMock = vi.mocked(cancelObjectGcCandidate);
const objectResponseMock = vi.mocked(objectResponse);
const sweepObjectGcCandidatesBestEffortMock = vi.mocked(sweepObjectGcCandidatesBestEffort);
const admitChatBackupRequestMock = vi.mocked(admitChatBackupRequest);
const completeChatBackupAdmissionMock = vi.mocked(completeChatBackupAdmission);
const enforceChatBackupEdgeRateLimitMock = vi.mocked(enforceChatBackupEdgeRateLimit);
const registerChatBackupObjectMock = vi.mocked(registerChatBackupObject);
const releaseChatBackupAdmissionBestEffortMock = vi.mocked(releaseChatBackupAdmissionBestEffort);
const reserveChatBackupBytesMock = vi.mocked(reserveChatBackupBytes);
const admitThumbnailUploadMock = vi.mocked(admitThumbnailUpload);
const releaseThumbnailAdmissionBestEffortMock = vi.mocked(releaseThumbnailAdmissionBestEffort);
const saveThumbnailMock = vi.mocked(saveThumbnail);

const quotaAdmission = {
  id: 'admission',
  ownerId: 'session',
  reservedBytes: 0,
  reservedObjects: 0,
  policyViolation: false,
};

describe('chat blob ownership', () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    findChatMock.mockReset().mockResolvedValue({
      id: 'chat-row',
      creator_id: 'session',
      initial_id: 'chat',
      url_id: null,
      description: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      snapshot_key: null,
      last_message_rank: null,
      last_subchat_index: 0,
      is_deleted: 0,
    });
    updateStorageStateMock.mockReset();
    allocateCustomerObjectKeyMock.mockReset().mockImplementation((_ownerId, prefix) => `${prefix}/new`);
    putObjectAtKeyMock.mockReset().mockResolvedValue(undefined);
    queueObjectGcCandidateMock
      .mockReset()
      .mockImplementation(async (_db, storageKey) => ({ storageKey, notBefore: 123 }));
    cancelObjectGcCandidateMock.mockReset().mockResolvedValue(true);
    getLatestStorageStateMock.mockReset();
    enforceChatStorageRetentionMock.mockReset();
    enforceChatStorageRetentionMock.mockResolvedValue(undefined);
    objectResponseMock.mockReset();
    sweepObjectGcCandidatesBestEffortMock.mockReset();
    admitChatBackupRequestMock.mockReset().mockResolvedValue(quotaAdmission);
    completeChatBackupAdmissionMock.mockReset().mockResolvedValue(undefined);
    enforceChatBackupEdgeRateLimitMock.mockReset().mockResolvedValue(undefined);
    registerChatBackupObjectMock.mockReset().mockResolvedValue(undefined);
    releaseChatBackupAdmissionBestEffortMock.mockReset().mockResolvedValue(undefined);
    reserveChatBackupBytesMock.mockReset().mockImplementation(async (_env, admission, reservedBytes) => ({
      ...admission,
      reservedBytes,
    }));
  });

  test('rejects an exact request-rate denial before parsing or uploading the multipart body', async () => {
    admitChatBackupRequestMock.mockRejectedValueOnce(new ChatBackupQuotaError('request-rate', 60));

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(reserveChatBackupBytesMock).not.toHaveBeenCalled();
    expect(putObjectAtKeyMock).not.toHaveBeenCalled();
  });

  test('releases an admitted request when the owned chat lookup returns not found', async () => {
    findChatMock.mockResolvedValueOnce(null);

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(404);
    expect(admitChatBackupRequestMock).toHaveBeenCalledOnce();
    expect(releaseChatBackupAdmissionBestEffortMock).toHaveBeenCalledWith(expect.anything(), quotaAdmission);
    expect(reserveChatBackupBytesMock).not.toHaveBeenCalled();
  });

  test('rejects a tenant byte-quota denial before allocating or uploading R2 objects', async () => {
    reserveChatBackupBytesMock.mockRejectedValueOnce(new ChatBackupQuotaError('storage'));

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(409);
    expect(allocateCustomerObjectKeyMock).not.toHaveBeenCalled();
    expect(putObjectAtKeyMock).not.toHaveBeenCalled();
    expect(releaseChatBackupAdmissionBestEffortMock).toHaveBeenCalledWith(expect.anything(), quotaAdmission);
  });

  test('leaves rejected backup objects on durable reference-aware cleanup receipts', async () => {
    updateStorageStateMock.mockResolvedValue({
      accepted: false,
      retainedStorageKey: false,
      retainedSnapshotKey: false,
      displacedKeys: [],
    });

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(409);
    expect(queuedObjectKeys()).toEqual(['message-history/new', 'snapshots/new']);
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
  });

  test('leaves cleanup queued when a concurrent chat deletion rejects the guarded D1 write', async () => {
    updateStorageStateMock.mockResolvedValue({
      accepted: false,
      retainedStorageKey: false,
      retainedSnapshotKey: false,
      displacedKeys: [],
    });

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(409);
    expect(queuedObjectKeys()).toEqual(['message-history/new', 'snapshots/new']);
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
  });

  test('rejects an oversized backup from Content-Length before parsing or uploading it', async () => {
    const request = storageRequest({ contentLength: 20 * 1024 * 1024 });

    const response = await storeChatAction({ request, env: storageEnv() });

    expect(response.status).toBe(413);
    expect(admitChatBackupRequestMock).toHaveBeenCalledOnce();
    expect(releaseChatBackupAdmissionBestEffortMock).toHaveBeenCalledOnce();
    expect(putObjectAtKeyMock).not.toHaveBeenCalled();
    expect(updateStorageStateMock).not.toHaveBeenCalled();
  });

  test('rejects a tiny LZ4 backup that declares an excessive expanded message history', async () => {
    const response = await storeChatAction({
      request: storageRequest({ messageExpandedBytes: 32 * 1024 * 1024 + 1 }),
      env: storageEnv(),
    });

    expect(response.status).toBe(413);
    expect(putObjectAtKeyMock).not.toHaveBeenCalled();
  });

  test('rejects an LZ4 block with an invalid back-reference before quota reservation or upload', async () => {
    const malformed = new Uint8Array([4, 0, 0, 0, 0, 0, 0]);
    const response = await storeChatAction({
      request: storageRequest({ messageBlob: new Blob([malformed]) }),
      env: storageEnv(),
    });

    expect(response.status).toBe(400);
    expect(reserveChatBackupBytesMock).not.toHaveBeenCalled();
    expect(putObjectAtKeyMock).not.toHaveBeenCalled();
  });

  test('rejects many duplicate multipart fields before uploading or reserving retention', async () => {
    const response = await storeChatAction({
      request: storageRequest({ duplicateFirstMessages: 500 }),
      env: storageEnv(),
    });

    expect(response.status).toBe(400);
    expect(putObjectAtKeyMock).not.toHaveBeenCalled();
    expect(enforceChatStorageRetentionMock).not.toHaveBeenCalled();
  });

  test('does not upload when checkpoint retention cannot reserve capacity', async () => {
    enforceChatStorageRetentionMock.mockRejectedValueOnce(new ChatStorageRetentionError());

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(409);
    expect(putObjectAtKeyMock).not.toHaveBeenCalled();
    expect(updateStorageStateMock).not.toHaveBeenCalled();
  });

  test('keeps blobs accepted by the storage-state write', async () => {
    updateStorageStateMock.mockResolvedValue({
      accepted: true,
      retainedStorageKey: true,
      retainedSnapshotKey: true,
      displacedKeys: [],
    });

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(200);
    expect(allocateCustomerObjectKeyMock).toHaveBeenNthCalledWith(1, 'session', 'message-history');
    expect(allocateCustomerObjectKeyMock).toHaveBeenNthCalledWith(2, 'session', 'snapshots');
    expect(cancelObjectGcCandidateMock.mock.calls.map(([, receipt]) => receipt.storageKey)).toEqual([
      'message-history/new',
      'snapshots/new',
    ]);
  });

  test('cancels only the receipt whose uploaded object is proven live', async () => {
    updateStorageStateMock.mockResolvedValue({
      accepted: true,
      retainedStorageKey: false,
      retainedSnapshotKey: true,
      displacedKeys: [],
    });

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(200);
    expect(cancelObjectGcCandidateMock).toHaveBeenCalledOnce();
    expect(cancelObjectGcCandidateMock.mock.calls[0]?.[1]).toEqual({
      storageKey: 'snapshots/new',
      notBefore: 123,
    });
  });

  test('defers displaced-key cleanup and runs a bounded opportunistic sweep', async () => {
    updateStorageStateMock.mockResolvedValue({
      accepted: true,
      retainedStorageKey: true,
      retainedSnapshotKey: true,
      displacedKeys: ['message-old', 'snapshot-old'],
    });
    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(200);
    expect(cancelObjectGcCandidateMock).toHaveBeenCalledTimes(2);
    expect(sweepObjectGcCandidatesBestEffortMock).toHaveBeenCalledOnce();
  });

  test('does not cancel either receipt when the database update fails', async () => {
    updateStorageStateMock.mockRejectedValue(new Error('database unavailable'));

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(500);
    expect(queuedObjectKeys()).toEqual(['message-history/new', 'snapshots/new']);
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
  });

  test('leaves both receipts queued when the second upload fails', async () => {
    putObjectAtKeyMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('R2 unavailable'));

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(500);
    expect(queuedObjectKeys()).toEqual(['message-history/new', 'snapshots/new']);
    expect(registerChatBackupObjectMock).toHaveBeenCalledTimes(2);
    expect(releaseChatBackupAdmissionBestEffortMock).toHaveBeenCalledOnce();
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
    expect(updateStorageStateMock).not.toHaveBeenCalled();
  });

  test('preserves receipts when both D1 references commit before their acknowledgement is lost', async () => {
    const committedReferences = new Set<string>();
    updateStorageStateMock.mockImplementationOnce(async (_db, args) => {
      committedReferences.add(args.storageKey!);
      committedReferences.add(args.snapshotKey!);
      throw new Error('D1 acknowledgement lost');
    });

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(500);
    expect(committedReferences).toEqual(new Set(['message-history/new', 'snapshots/new']));
    expect(queuedObjectKeys()).toEqual(['message-history/new', 'snapshots/new']);
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
  });

  test('queues each backup key before an R2 commit loses its acknowledgement', async () => {
    const committedObjects = new Set<string>();
    putObjectAtKeyMock.mockImplementationOnce(async (_env, key) => {
      committedObjects.add(key);
      throw new Error('R2 acknowledgement lost');
    });

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(500);
    expect(committedObjects).toEqual(new Set(['message-history/new']));
    expect(queuedObjectKeys()).toEqual(['message-history/new']);
    expect(queueObjectGcCandidateMock.mock.invocationCallOrder[0]).toBeLessThan(
      putObjectAtKeyMock.mock.invocationCallOrder[0],
    );
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
    expect(updateStorageStateMock).not.toHaveBeenCalled();
  });

  test('keeps both receipts when the snapshot PUT commits before losing its acknowledgement', async () => {
    const committedObjects = new Set<string>();
    putObjectAtKeyMock
      .mockImplementationOnce(async (_env, key) => {
        committedObjects.add(key);
      })
      .mockImplementationOnce(async (_env, key) => {
        committedObjects.add(key);
        throw new Error('R2 acknowledgement lost');
      });

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(500);
    expect(committedObjects).toEqual(new Set(['message-history/new', 'snapshots/new']));
    expect(queuedObjectKeys()).toEqual(['message-history/new', 'snapshots/new']);
    expect(queueObjectGcCandidateMock.mock.invocationCallOrder[1]).toBeLessThan(
      putObjectAtKeyMock.mock.invocationCallOrder[1],
    );
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
    expect(updateStorageStateMock).not.toHaveBeenCalled();
  });

  test('rejects a stale transcript before uploading any blobs', async () => {
    const advanced = { ...checkpoint, revision: 2, digest: 'b'.repeat(64), messageCount: 4 };

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv(advanced) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'The agent transcript advanced before this backup was saved. Retry with the latest transcript.',
      checkpoint: advanced,
    });
    expect(putObjectAtKeyMock).not.toHaveBeenCalled();
    expect(updateStorageStateMock).not.toHaveBeenCalled();
  });

  test('leaves uploaded objects queued when the transcript advances during upload', async () => {
    const advanced = { ...checkpoint, revision: 2, digest: 'b'.repeat(64), messageCount: 4 };

    const response = await storeChatAction({
      request: storageRequest(),
      env: storageEnv(checkpoint, advanced),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'The agent transcript advanced before this backup was saved. Retry with the latest transcript.',
      checkpoint: advanced,
    });
    expect(queuedObjectKeys()).toEqual(['message-history/new', 'snapshots/new']);
    expect(cancelObjectGcCandidateMock).not.toHaveBeenCalled();
    expect(updateStorageStateMock).not.toHaveBeenCalled();
  });

  test('does not fail a committed save when cleanup-receipt cancellation fails', async () => {
    updateStorageStateMock.mockResolvedValue({
      accepted: true,
      retainedStorageKey: true,
      retainedSnapshotKey: true,
      displacedKeys: [],
    });
    cancelObjectGcCandidateMock.mockRejectedValue(new Error('D1 cleanup unavailable'));

    const response = await storeChatAction({ request: storageRequest(), env: storageEnv() });

    expect(response.status).toBe(200);
    expect(cancelObjectGcCandidateMock).toHaveBeenCalledTimes(2);
  });
});

describe('thumbnail body limits', () => {
  beforeEach(() => {
    putObjectAtKeyMock.mockReset();
    admitThumbnailUploadMock.mockReset().mockResolvedValue({
      id: 'thumbnail-admission',
      ownerId: 'session',
      chatId: 'chat-row',
      reservedBytes: 0,
      reservedObjects: 0,
      expectedStorageKey: null,
    });
    releaseThumbnailAdmissionBestEffortMock.mockReset().mockResolvedValue(undefined);
    saveThumbnailMock.mockReset();
  });

  test('releases admission when object persistence fails after a valid body is read', async () => {
    saveThumbnailMock.mockRejectedValueOnce(new Error('R2 unavailable'));
    const response = await uploadThumbnailAction({
      request: new Request('https://ghostbuild.dev/api/thumbnails?sessionId=session&chatId=chat', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: new Uint8Array([1]),
      }),
      env: storageEnv(),
    });

    expect(response.status).toBe(500);
    expect(saveThumbnailMock).toHaveBeenCalledOnce();
    expect(releaseThumbnailAdmissionBestEffortMock).toHaveBeenCalledOnce();
  });

  test('rejects tenant-concurrent admission before reading the request stream', async () => {
    admitThumbnailUploadMock.mockRejectedValueOnce(new ThumbnailQuotaError('in-flight', 60));
    const request = new Request('https://ghostbuild.dev/api/thumbnails?sessionId=session&chatId=chat', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const response = await uploadThumbnailAction({
      request,
      env: storageEnv(),
    });

    expect(response.status).toBe(429);
    expect(request.bodyUsed).toBe(false);
    expect(releaseThumbnailAdmissionBestEffortMock).not.toHaveBeenCalled();
  });

  test('rejects an oversized declared body before materializing the thumbnail', async () => {
    const response = await uploadThumbnailAction({
      request: new Request('https://ghostbuild.dev/api/thumbnails?sessionId=session&chatId=chat', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(5 * 1024 * 1024 + 1) },
        body: new Uint8Array([1]),
      }),
      env: storageEnv(),
    });

    expect(response.status).toBe(413);
    expect(putObjectAtKeyMock).not.toHaveBeenCalled();
    expect(releaseThumbnailAdmissionBestEffortMock).toHaveBeenCalledOnce();
  });

  test('rejects an oversized chunked thumbnail stream without Content-Length', async () => {
    const response = await uploadThumbnailAction({
      request: new Request('https://ghostbuild.dev/api/thumbnails?sessionId=session&chatId=chat', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(5 * 1024 * 1024));
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit),
      env: storageEnv(),
    });

    expect(response.status).toBe(413);
    expect(putObjectAtKeyMock).not.toHaveBeenCalled();
    expect(releaseThumbnailAdmissionBestEffortMock).toHaveBeenCalledOnce();
  });
});

describe('storage object reads', () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    objectResponseMock.mockReset();
    objectResponseMock.mockResolvedValue(new Response('object'));
  });

  test('serves a shared thumbnail without a session without caching revocable access', async () => {
    const response = await storageObjectAction({
      request: new Request('https://ghostbuild.dev/api/storage/thumbnails%2Fpublic'),
      key: 'thumbnails%2Fpublic',
      env: storageReadEnv([{ found: 1 }]),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(objectResponseMock).toHaveBeenCalledWith(expect.anything(), 'thumbnails/public');
    expect(getAuthSession).not.toHaveBeenCalled();
  });

  test('does not reveal a private object to an anonymous request', async () => {
    getAuthSession.mockResolvedValue(null);
    const response = await storageObjectAction({
      request: new Request('https://ghostbuild.dev/api/storage/snapshots%2Fprivate'),
      key: 'snapshots%2Fprivate',
      env: storageReadEnv([null]),
    });

    expect(response.status).toBe(404);
    expect(objectResponseMock).not.toHaveBeenCalled();
  });

  test('serves an object referenced by the authenticated owner without shared caching', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    const env = storageReadEnv([null, { found: 1 }]);
    const response = await storageObjectAction({
      request: new Request('https://ghostbuild.dev/api/storage/snapshots%2Fowned'),
      key: 'snapshots%2Fowned',
      env,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(env.DB.prepare).toHaveBeenCalledTimes(2);
    expect(objectResponseMock).toHaveBeenCalledWith(expect.anything(), 'snapshots/owned');
  });

  test('rejects malformed encoded keys before querying storage', async () => {
    const env = storageReadEnv([]);
    const response = await storageObjectAction({
      request: new Request('https://ghostbuild.dev/api/storage/invalid'),
      key: '%E0%A4%A',
      env,
    });

    expect(response.status).toBe(404);
    expect(env.DB.prepare).not.toHaveBeenCalled();
    expect(objectResponseMock).not.toHaveBeenCalled();
  });
});

describe('chat transcript reload', () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    getAuthSession.mockResolvedValue({ user: { id: 'session' } });
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

  test('initializes the Durable Object transcript with the authenticated owner', async () => {
    const messages = [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }];
    const getTranscriptSnapshotForOwner = vi.fn(async () => checkpointWithMessages(checkpoint, messages));

    const response = await initialMessagesAction({
      request: initialMessagesRequest(),
      env: {
        DB: {},
        APP_STORAGE: {},
        BuilderAgent: {
          getByName: () => ({ getTranscriptSnapshotForOwner }),
        },
      } as unknown as Env,
    });

    expect(response.status).toBe(200);
    expect(getTranscriptSnapshotForOwner).toHaveBeenCalledWith(
      {
        agentName: checkpoint.agentName,
        generation: checkpoint.generation,
        subchatIndex: checkpoint.subchatIndex,
      },
      'session',
    );
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

  test('returns an empty chat when a new Durable Object transcript is not initialized yet', async () => {
    getLatestStorageStateMock.mockResolvedValue(null);
    const response = await initialMessagesAction({
      request: initialMessagesRequest(),
      env: {
        DB: {},
        APP_STORAGE: {},
        BuilderAgent: {
          getByName: () => ({
            getTranscriptSnapshotForOwner: async () => {
              // Durable Object RPC serializes a thrown Response into an opaque Error.
              throw new Error('#<Response>');
            },
          }),
        },
      } as unknown as Env,
    });

    expect(response.status).toBe(204);
    expect(objectResponseMock).not.toHaveBeenCalled();
  });
});

function storageRequest(
  options: {
    contentLength?: number;
    messageExpandedBytes?: number;
    snapshotExpandedBytes?: number;
    messageBlob?: Blob;
    duplicateFirstMessages?: number;
  } = {},
): Request {
  const body = new FormData();
  body.set(
    'messages',
    options.messageBlob ??
      lz4TestBlob(options.messageExpandedBytes ?? 128, MESSAGE_HISTORY_LZ4_LIMITS.decompressedBytes),
  );
  body.set(
    'snapshot',
    lz4TestBlob(options.snapshotExpandedBytes ?? 256, PROJECT_SNAPSHOT_LZ4_LIMITS.decompressedBytes),
  );
  for (let index = 0; index < (options.duplicateFirstMessages ?? 0); index++) {
    body.append('firstMessage', '');
  }
  return new Request(
    `https://ghostbuild.dev/api/chats/store?sessionId=session&chatId=chat&lastMessageRank=2&partIndex=1&transcriptAgentName=chat&transcriptGeneration=0&transcriptRevision=1&transcriptDigest=${checkpoint.digest}&transcriptMessageCount=3`,
    {
      method: 'POST',
      body,
      ...(options.contentLength === undefined ? {} : { headers: { 'Content-Length': String(options.contentLength) } }),
    },
  );
}

function queuedObjectKeys(): string[] {
  return queueObjectGcCandidateMock.mock.calls.map(([, key]) => key);
}

function lz4TestBlob(expandedBytes: number, maximumExpandedBytes: number): Blob {
  if (expandedBytes > maximumExpandedBytes) {
    const declaredOnly = new Uint8Array(5);
    new DataView(declaredOnly.buffer).setUint32(0, expandedBytes, true);
    return new Blob([declaredOnly], { type: 'application/octet-stream' });
  }
  const extensions: number[] = [];
  if (expandedBytes >= 15) {
    let remaining = expandedBytes - 15;
    while (remaining >= 255) {
      extensions.push(255);
      remaining -= 255;
    }
    extensions.push(remaining);
  }
  const bytes = new Uint8Array(4 + 1 + extensions.length + expandedBytes);
  new DataView(bytes.buffer).setUint32(0, expandedBytes, true);
  bytes[4] = Math.min(expandedBytes, 15) << 4;
  bytes.set(extensions, 5);
  return new Blob([bytes], { type: 'application/octet-stream' });
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
        getTranscriptSnapshotForOwner: async () =>
          snapshots[Math.min(call++, snapshots.length - 1)] ?? {
            checkpoint,
            messages: [],
          },
      }),
    },
  } as unknown as Env;
}

function storageReadEnv(rows: Array<{ found: number } | null>): Env {
  let call = 0;
  const prepare = vi.fn(() => ({
    bind: () => ({
      first: async () => rows[call++] ?? null,
    }),
  }));
  return { DB: { prepare }, APP_STORAGE: {} } as unknown as Env;
}
