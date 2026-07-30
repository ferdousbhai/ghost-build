import { beforeEach, describe, expect, test, vi } from 'vitest';
import { customerR2Api, GHOSTBUILD_CUSTOMER_BUCKET } from '~/lib/.server/cloudflare/customer-r2';
import {
  allocateCustomerObjectKey,
  deleteObject,
  getObjectBytes,
  objectHead,
  objectResponse,
  putObjectAtKey,
} from './object-storage.server';

vi.mock('~/lib/.server/cloudflare/customer-r2', () => ({
  customerR2Api: vi.fn(),
  GHOSTBUILD_CUSTOMER_BUCKET: 'ghostbuild-user-data',
}));

const customerR2ApiMock = vi.mocked(customerR2Api);
const api = {
  ensureR2Bucket: vi.fn(),
  putR2Object: vi.fn(),
  getR2Object: vi.fn(),
  headR2Object: vi.fn(),
  deleteR2Object: vi.fn(),
};

describe('customer-owned object storage', () => {
  beforeEach(() => {
    customerR2ApiMock.mockReset().mockResolvedValue(api as never);
    for (const method of Object.values(api)) {
      method.mockReset();
    }
    api.ensureR2Bucket.mockResolvedValue({ id: GHOSTBUILD_CUSTOMER_BUCKET, name: GHOSTBUILD_CUSTOMER_BUCKET });
    api.putR2Object.mockResolvedValue(undefined);
    api.deleteR2Object.mockResolvedValue(undefined);
  });

  test('routes a customer key to the owner Cloudflare bucket', async () => {
    const key = allocateCustomerObjectKey('user-123', 'snapshots');
    const blob = new Blob(['project'], { type: 'application/x-lz4' });

    await putObjectAtKey(storageEnv(), key, blob);

    expect(customerR2ApiMock).toHaveBeenCalledWith(expect.any(Object), 'user-123');
    expect(api.ensureR2Bucket).toHaveBeenCalledWith(GHOSTBUILD_CUSTOMER_BUCKET);
    expect(api.putR2Object).toHaveBeenCalledWith(GHOSTBUILD_CUSTOMER_BUCKET, key, blob, 'application/x-lz4');
  });

  test('reads, heads, and deletes through the customer API', async () => {
    const key = allocateCustomerObjectKey('user-123', 'message-history');
    api.getR2Object.mockImplementation(async () => new Response('history', { headers: { etag: 'remote-etag' } }));
    api.headR2Object.mockResolvedValue(new Response(null, { headers: { 'content-length': '7' } }));

    const response = await objectResponse(storageEnv(), key);
    const bytes = await getObjectBytes(storageEnv(), key);
    const head = await objectHead(storageEnv(), key);
    await deleteObject(storageEnv(), key);

    expect(await response.text()).toBe('history');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(bytes).not.toBeNull();
    if (!bytes) {
      throw new Error('Expected customer object bytes.');
    }
    expect(new TextDecoder().decode(bytes)).toBe('history');
    expect(head).toEqual({ size: 7 });
    expect(api.deleteR2Object).toHaveBeenCalledWith(GHOSTBUILD_CUSTOMER_BUCKET, key);
  });
});

function storageEnv(): Env {
  return {
    DB: {} as D1Database,
    APP_STORAGE: {} as R2Bucket,
  } as Env;
}
