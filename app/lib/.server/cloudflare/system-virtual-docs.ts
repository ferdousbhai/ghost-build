import type { VirtualDocOverrides } from 'ghostbuild-agent/virtual-docs';

export const PUBLISHED_CLOUDFLARE_WEEKLY_DOC_KEY = 'published/cloudflareWeekly';
const MAX_DYNAMIC_DOC_BYTES = 32 * 1024;

type PublishedVirtualDoc = {
  version: 1;
  docKey: 'cloudflareWeekly';
  sourceRevision: string;
  contentSha256: string;
  content: string;
  publishedAt: number;
};

export async function loadSystemVirtualDocs(namespace: KVNamespace): Promise<VirtualDocOverrides> {
  const stored = await namespace.get(PUBLISHED_CLOUDFLARE_WEEKLY_DOC_KEY, 'text');
  if (!stored || new TextEncoder().encode(stored).byteLength > MAX_DYNAMIC_DOC_BYTES + 1_024) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return {};
  }
  if (!isPublishedVirtualDoc(value)) {
    return {};
  }
  const contentBytes = new TextEncoder().encode(value.content);
  if (contentBytes.byteLength === 0 || contentBytes.byteLength > MAX_DYNAMIC_DOC_BYTES) {
    return {};
  }
  if ((await sha256Hex(contentBytes)) !== value.contentSha256) {
    return {};
  }
  return { cloudflareWeekly: value.content };
}

function isPublishedVirtualDoc(value: unknown): value is PublishedVirtualDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const doc = value as Record<string, unknown>;
  return (
    Object.keys(doc).length === 6 &&
    doc.version === 1 &&
    doc.docKey === 'cloudflareWeekly' &&
    typeof doc.sourceRevision === 'string' &&
    /^[a-f0-9]{40}$/.test(doc.sourceRevision) &&
    typeof doc.contentSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(doc.contentSha256) &&
    typeof doc.content === 'string' &&
    typeof doc.publishedAt === 'number' &&
    Number.isSafeInteger(doc.publishedAt) &&
    doc.publishedAt > 0
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(value).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
