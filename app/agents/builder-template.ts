import {
  BUILDER_WORKSPACE_SYNC_BATCH_BYTES,
  BUILDER_WORKSPACE_SYNC_BATCH_FILES,
  type BuilderWorkspaceFileInput,
} from './builder-workspace-types';
import { BUILDER_TEMPLATE_GZIP_BASE64, BUILDER_TEMPLATE_SOURCE_SHA256 } from './builder-template.generated';

let cachedTemplate: Promise<BuilderWorkspaceFileInput[]> | undefined;

export function builderTemplateSeedId(): string {
  return `template_${BUILDER_TEMPLATE_SOURCE_SHA256}`;
}

export function loadBuilderTemplate(): Promise<BuilderWorkspaceFileInput[]> {
  cachedTemplate ??= decodeBuilderTemplate();
  return cachedTemplate;
}

export function batchBuilderWorkspaceSeed(entries: BuilderWorkspaceFileInput[]): BuilderWorkspaceFileInput[][] {
  const batches: BuilderWorkspaceFileInput[][] = [];
  let batch: BuilderWorkspaceFileInput[] = [];
  let characters = 0;
  for (const entry of entries) {
    const entryCharacters = entry.path.length + entry.content.length;
    if (
      batch.length > 0 &&
      (batch.length >= BUILDER_WORKSPACE_SYNC_BATCH_FILES ||
        characters + entryCharacters > BUILDER_WORKSPACE_SYNC_BATCH_BYTES * 6)
    ) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(entry);
    characters += entryCharacters;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

function decodedBytes(entry: BuilderWorkspaceFileInput): number {
  if ((entry.encoding ?? 'utf8') === 'utf8') {
    return new TextEncoder().encode(entry.content).byteLength;
  }
  const padding = entry.content.endsWith('==') ? 2 : entry.content.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((entry.content.length * 3) / 4) - padding);
}

export function builderTemplateTotals(entries: BuilderWorkspaceFileInput[]): {
  fileCount: number;
  totalBytes: number;
} {
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + decodedBytes(entry), 0),
  };
}

async function decodeBuilderTemplate(): Promise<BuilderWorkspaceFileInput[]> {
  const compressed = decodeBase64(BUILDER_TEMPLATE_GZIP_BASE64);
  const stream = new Blob([compressed as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const json = new TextDecoder().decode(await new Response(stream).arrayBuffer());
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('The bundled Builder template is invalid.');
  }
  return parsed.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { path?: unknown }).path !== 'string' ||
      typeof (entry as { content?: unknown }).content !== 'string' ||
      (entry as { encoding?: unknown }).encoding !== 'base64'
    ) {
      throw new Error('The bundled Builder template contains an invalid file.');
    }
    return entry as BuilderWorkspaceFileInput;
  });
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
