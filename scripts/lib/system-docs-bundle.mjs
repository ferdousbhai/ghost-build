import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const SYSTEM_DOCS_PUBLISHED_KEY = 'published/docs-bundle/v1';
export const SYSTEM_DOCS_MANAGED_KEY = 'managed/docs-bundle/v1';
const SYSTEM_DOCS_BUNDLE_VERSION = 1;

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DOCUMENTS = 128;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function packSystemDocsDirectory(directory) {
  const root = resolve(directory);
  const manifest = parseManifest(
    await readBoundedFile(resolve(root, 'manifest.json'), MAX_MANIFEST_BYTES, 'System documentation manifest'),
  );
  const documents = [];
  let aggregateBytes = 0;

  for (const entry of manifest.documents) {
    const path = resolve(root, `${entry.id}.md`);
    if (!path.startsWith(`${root}${sep}`)) {
      throw new Error(`System documentation path escaped its root: ${entry.id}.md`);
    }
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error(`System documentation must be a regular file: ${entry.id}.md`);
    }
    const content = await readBoundedFile(path, MAX_DOCUMENT_BYTES, `System document ${entry.id}`);
    if (content.trim().length === 0) {
      throw new Error(`System document is empty: ${entry.id}.md`);
    }
    aggregateBytes += Buffer.byteLength(content);
    if (aggregateBytes > MAX_BUNDLE_BYTES) {
      throw new Error('System documentation exceeds its aggregate size limit.');
    }
    documents.push({ id: entry.id, description: entry.description, content });
  }

  const bundle = { version: SYSTEM_DOCS_BUNDLE_VERSION, documents };
  const serialized = JSON.stringify(bundle);
  if (Buffer.byteLength(serialized) > MAX_BUNDLE_BYTES) {
    throw new Error('Published system documentation bundle is too large.');
  }
  const managedDocuments = documents.map((document) => ({
    ...document,
    title: manifest.documents.find(({ id }) => id === document.id).title,
    sha256: sha256(document.content),
  }));
  const generationId = sha256(
    JSON.stringify({ version: SYSTEM_DOCS_BUNDLE_VERSION, sources: manifest.sources, documents: managedDocuments }),
  );
  const timestamp = Date.now();
  const managedBundle = {
    version: SYSTEM_DOCS_BUNDLE_VERSION,
    generationId,
    generatedAt: timestamp,
    publishedAt: timestamp,
    sources: manifest.sources,
    documents: managedDocuments,
  };
  return { bundle, serialized, managedBundle, managedSerialized: JSON.stringify(managedBundle) };
}

function parseManifest(value) {
  let manifest;
  try {
    manifest = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `System documentation manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isRecord(manifest) ||
    !Array.isArray(manifest.sources) ||
    !Array.isArray(manifest.documents) ||
    manifest.documents.length > MAX_DOCUMENTS
  ) {
    throw new Error('System documentation manifest is invalid.');
  }
  const documents = manifest.documents.map(parseDocumentEntry);
  requireUniqueIds(documents);
  const sources = manifest.sources.map(parseSource);
  return { sources, documents };
}

function parseSource(value) {
  if (
    !isRecord(value) ||
    !validId(value.id) ||
    !boundedString(value.title, 120) ||
    !boundedString(value.url, 2_048) ||
    !boundedString(value.revision, 256)
  ) {
    throw new Error('System documentation source is invalid.');
  }
  return { id: value.id, title: value.title, url: value.url, revision: value.revision };
}

function parseDocumentEntry(value) {
  if (!isRecord(value)) {
    throw new Error('System documentation entry has an unexpected shape.');
  }
  if (!validId(value.id) || !boundedString(value.title, 120) || !boundedString(value.description, 500)) {
    throw new Error('System documentation entry is invalid.');
  }
  return { id: value.id, title: value.title, description: value.description };
}

async function readBoundedFile(path, limit, label) {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size === 0 || file.size > limit) {
    throw new Error(`${label} is missing, empty, or too large.`);
  }
  return readFile(path, 'utf8');
}

function requireUniqueIds(values) {
  const ids = values.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('System documentation contains a duplicate document id.');
  }
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
