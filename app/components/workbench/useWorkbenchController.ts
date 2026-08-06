import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useState } from 'react';
import { getAbsolutePath } from 'ghostbuild-agent/utils/workDir';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { toast } from 'sonner';
import type {
  OnChangeCallback as OnEditorChange,
  OnScrollCallback as OnEditorScroll,
  OnWheelCallback as OnEditorWheel,
} from '~/components/editor/codemirror/CodeMirrorEditor';
import useViewport from '~/lib/hooks/useViewport';
import { workbenchStore, type WorkbenchViewType } from '~/lib/stores/workbench.client';
import { chatStore, useChatId } from '~/lib/stores/chatId';

const logger = createScopedLogger('WorkbenchController');

export function useWorkbenchController(isStreaming?: boolean) {
  const projectId = useChatId();
  const previewState = useStore(workbenchStore.previewState);
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const selectedFile = useStore(workbenchStore.selectedFile);
  const currentDocument = useStore(workbenchStore.currentDocument);
  const unsavedFiles = useStore(workbenchStore.unsavedFiles);
  const files = useStore(workbenchStore.files);
  const selectedView = useStore(workbenchStore.currentView);
  const following = useStore(workbenchStore.followingStreamedCode);
  const isSmallViewport = useViewport(1024);
  const [hasLoadedPreview, setHasLoadedPreview] = useState(false);
  const [previewRequesting, setPreviewRequesting] = useState(false);
  const hasPreview = Boolean(previewState.active ?? previewState.lastSuccessful);

  useEffect(() => {
    if (hasPreview) {
      workbenchStore.currentView.set('preview');
    }
  }, [hasPreview]);

  useEffect(() => {
    if (selectedView === 'preview') {
      setHasLoadedPreview(true);
    }
  }, [selectedView]);

  useEffect(() => {
    workbenchStore.setDocuments(files);
  }, [files]);

  const onEditorChange = useCallback<OnEditorChange>(
    (update) => {
      const updatePath = getAbsolutePath(update.filePath);
      if (update.projectId !== projectId) {
        logger.debug(`Editor update ignored for stale project, changed: ${update.projectId} current: ${projectId}`);
        return;
      }
      workbenchStore.setDocumentContent(updatePath, update.content);
    },
    [projectId],
  );

  const onEditorScroll = useCallback<OnEditorScroll>(
    (position) => workbenchStore.setCurrentDocumentScrollPosition(position),
    [],
  );
  const onEditorWheel = useCallback<OnEditorWheel>(() => workbenchStore.stopFollowingStreamedCode(), []);
  const onFileSelect = useCallback((filePath: string | undefined) => {
    workbenchStore.flushPendingEditorChange();
    workbenchStore.followingStreamedCode.set(false);
    workbenchStore.setSelectedFile(filePath ? getAbsolutePath(filePath) : undefined);
  }, []);
  const onFileSave = useCallback(() => {
    workbenchStore.flushPendingEditorChange();
    void (async () => {
      try {
        await workbenchStore.saveCurrentDocument();
      } catch (error) {
        logger.error('Failed to save the file', error);
        toast.error('Save failed');
        return;
      }
      try {
        workbenchStore.updatePreview(await workbenchStore.requestPreview());
      } catch (error) {
        logger.warn('Failed to update the preview after a file save', error);
        toast.error('Preview update failed');
      }
    })();
  }, []);

  const onPreviewRequest = useCallback(async () => {
    setPreviewRequesting(true);
    try {
      workbenchStore.updatePreview(await workbenchStore.requestPreview());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to queue a remote preview.');
    } finally {
      setPreviewRequesting(false);
    }
  }, []);

  return {
    close: () => {
      chatStore.setKey('showChat', true);
      workbenchStore.showWorkbench.set(false);
    },
    currentDocument,
    files,
    following,
    hasLoadedPreview,
    isSmallViewport,
    onEditorChange,
    onEditorScroll,
    onEditorWheel,
    onFileReset: () => workbenchStore.resetCurrentDocument(),
    onFileSave,
    onFileSelect,
    onPreviewRequest,
    previewRequesting,
    previewState,
    projectId,
    selectedFile,
    selectedView,
    setSelectedView: (view: WorkbenchViewType) => workbenchStore.currentView.set(view),
    showWorkbench,
    unsavedFiles,
    scrollToDocAppend: following && isStreaming,
  };
}
