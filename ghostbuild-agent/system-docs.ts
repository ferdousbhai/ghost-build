export const SYSTEM_DOCS_BUNDLE_VERSION = 1 as const;
export const SYSTEM_DOCS_PUBLISHED_KEY = 'published/docs-bundle/v1';

export const MAX_SYSTEM_DOCS = 128;
export const MAX_SYSTEM_DOC_BYTES = 256 * 1024;
export const MAX_SYSTEM_DOCS_BUNDLE_BYTES = 1024 * 1024;

const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type SystemDoc = {
  id: string;
  description: string;
  content: string;
};

export type SystemDocsBundle = {
  version: typeof SYSTEM_DOCS_BUNDLE_VERSION;
  documents: SystemDoc[];
};

export function parseSystemDocsBundle(value: string | null): SystemDocsBundle | null {
  if (!value || byteLength(value) > MAX_SYSTEM_DOCS_BUNDLE_BYTES) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['version', 'documents']) ||
    parsed.version !== SYSTEM_DOCS_BUNDLE_VERSION ||
    !Array.isArray(parsed.documents) ||
    parsed.documents.length === 0 ||
    parsed.documents.length > MAX_SYSTEM_DOCS
  ) {
    return null;
  }

  const documents = parsed.documents.map(parseDocument);
  if (documents.some((document) => document === null)) {
    return null;
  }
  const validDocuments = documents as SystemDoc[];
  if (new Set(validDocuments.map(({ id }) => id)).size !== validDocuments.length) {
    return null;
  }

  let contentBytes = 0;
  for (const document of validDocuments) {
    const bytes = byteLength(document.content);
    contentBytes += bytes;
    if (bytes === 0 || bytes > MAX_SYSTEM_DOC_BYTES || contentBytes > MAX_SYSTEM_DOCS_BUNDLE_BYTES) {
      return null;
    }
  }

  return { version: SYSTEM_DOCS_BUNDLE_VERSION, documents: validDocuments };
}

function parseDocument(value: unknown): SystemDoc | null {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'description', 'content'])) {
    return null;
  }
  if (
    typeof value.id !== 'string' ||
    !DOC_ID_PATTERN.test(value.id) ||
    !boundedString(value.description, 500) ||
    typeof value.content !== 'string' ||
    value.content.trim().length === 0
  ) {
    return null;
  }
  return { id: value.id, description: value.description, content: value.content };
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join('\n') === keys.toSorted().join('\n');
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
