import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchStore } from './workbench.client';
import type { AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import type { BuilderWorkspaceSyncEntry } from '~/agents/builder-workspace-types';

const downloadProject = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('~/lib/download/download-project', () => ({ downloadProject }));

const fileA = '/home/project/a.ts' as AbsolutePath;
const fileB = '/home/project/b.ts' as AbsolutePath;

function createStore() {
  const store = new WorkbenchStore();
  store.activateWorkspace('workspace-a');
  store.files.set({
    [fileA]: { type: 'file', content: 'a0', isBinary: false },
    [fileB]: { type: 'file', content: 'b0', isBinary: false },
  });
  store.setDocuments(store.files.get());
  store.setSelectedFile(fileA);
  return store;
}

function syncWrite(path: AbsolutePath, content: string, revision = 1): BuilderWorkspaceSyncEntry {
  return {
    kind: 'write',
    path,
    content,
    encoding: 'utf8',
    size: new TextEncoder().encode(content).byteLength,
    sha256: 'a'.repeat(64),
    revision,
  };
}

describe('WorkbenchStore editor flush boundaries', () => {
  beforeEach(() => downloadProject.mockClear());

  it('flushes the original file before changing selection', () => {
    const store = createStore();
    const flush = vi.fn(() => store.setDocumentContent(fileA, 'a1'));
    store.registerPendingEditorChangeFlusher(flush);

    store.setSelectedFile(fileB);

    expect(flush).toHaveBeenCalledOnce();
    expect(store.unsavedFiles.get()).toContain(fileA);
    expect(store.currentDocument.get()?.filePath).toBe(fileB);
  });

  it('flushes visible content before a manual durable save', async () => {
    const store = createStore();
    const apply = vi.fn(async () => ({
      ok: true as const,
      changedPaths: [fileA],
      state: { initialized: true, revision: 2, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    }));
    store.setWorkspaceChangeListener(apply);
    store.registerPendingEditorChangeFlusher(() => store.setDocumentContent(fileA, 'latest visible content'));

    await store.saveCurrentDocument();

    expect(apply).toHaveBeenCalledWith([
      { kind: 'write', path: fileA, content: 'latest visible content', encoding: 'utf8' },
    ]);
    expect(store.unsavedFiles.get()).not.toContain(fileA);
  });

  it('saves every browser-only edit before a builder turn', async () => {
    const store = createStore();
    const apply = vi.fn(async () => ({
      ok: true as const,
      changedPaths: [fileA],
      state: { initialized: true, revision: 2, resetRevision: 0, fileCount: 2, totalBytes: 4, seeding: false },
    }));
    store.setWorkspaceChangeListener(apply);
    store.setDocumentContent(fileA, 'a1');
    store.setDocumentContent(fileB, 'b1');

    await store.saveUnsavedFiles();

    expect(apply).toHaveBeenNthCalledWith(1, [{ kind: 'write', path: fileA, content: 'a1', encoding: 'utf8' }]);
    expect(apply).toHaveBeenNthCalledWith(2, [{ kind: 'write', path: fileB, content: 'b1', encoding: 'utf8' }]);
    expect(store.unsavedFiles.get()).toEqual(new Set());
  });

  it('tracks visible unsaved content until it is durably saved', () => {
    const store = createStore();
    store.registerPendingEditorChangeFlusher(() => store.setDocumentContent(fileA, 'latest visible content'));

    expect(store.getModifiedFiles()).toEqual({
      [fileA]: { type: 'file', content: 'latest visible content', isBinary: false },
    });
  });

  it('includes visible unsaved content in a downloaded project', async () => {
    const store = createStore();
    store.registerPendingEditorChangeFlusher(() => store.setDocumentContent(fileA, 'latest visible content'));

    await store.downloadZip();

    expect(downloadProject).toHaveBeenCalledWith(
      expect.objectContaining({
        [fileA]: { type: 'file', content: 'latest visible content', isBinary: false },
        [fileB]: { type: 'file', content: 'b0', isBinary: false },
      }),
      expect.any(String),
    );
  });

  it('does not write text into a binary document', () => {
    const store = createStore();
    store.files.setKey(fileA, { type: 'file', content: '', isBinary: true });
    store.setDocuments(store.files.get());

    store.setDocumentContent(fileA, 'stale text');

    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, isBinary: true, value: '' });
    expect(store.unsavedFiles.get()).not.toContain(fileA);
  });

  it('preserves visible unsaved text across a replacement snapshot', () => {
    const store = createStore();
    store.setDocumentContent(fileA, 'local edit');

    store.replaceWorkspaceSnapshot([syncWrite(fileA, 'new durable content'), syncWrite(fileB, 'b1')]);

    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, value: 'local edit' });
    expect(store.files.get()[fileA]).toMatchObject({ content: 'new durable content' });
    expect(store.unsavedFiles.get()).toContain(fileA);
  });

  it('keeps an unsaved file as a local recreation when the replacement snapshot deleted it', () => {
    const store = createStore();
    store.setDocumentContent(fileA, 'local edit');

    store.replaceWorkspaceSnapshot([syncWrite(fileB, 'b1')]);

    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, value: 'local edit' });
    expect(store.files.get()[fileA]).toMatchObject({ content: 'local edit' });
    expect(store.unsavedFiles.get()).toContain(fileA);
  });

  it('clears an unsaved marker when the replacement snapshot already contains the local text', () => {
    const store = createStore();
    store.setDocumentContent(fileA, 'same content');

    store.replaceWorkspaceSnapshot([syncWrite(fileA, 'same content'), syncWrite(fileB, 'b1')]);

    expect(store.currentDocument.get()).toMatchObject({ filePath: fileA, value: 'same content' });
    expect(store.unsavedFiles.get()).not.toContain(fileA);
  });

  it('drops every project-scoped presentation value before activating another workspace', () => {
    const store = createStore();
    store.setDocumentContent(fileA, 'private workspace-a edit');
    store.showWorkbench.set(true);
    store.currentView.set('preview');

    store.activateWorkspace('workspace-b');
    store.replaceWorkspaceSnapshot([syncWrite(fileB, 'workspace-b content')]);

    expect(store.files.get()[fileA]).toBeUndefined();
    expect(store.files.get()[fileB]).toMatchObject({ content: 'workspace-b content' });
    expect(store.unsavedFiles.get()).toEqual(new Set());
    expect(store.selectedFile.get()).toBe(fileB);
    expect(store.currentView.get()).toBe('code');
    expect(store.showWorkbench.get()).toBe(false);
    expect(store.previewState.get().active).toBeNull();
    expect(store.previewState.get().lastSuccessful).toBeNull();
  });
});
