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
import { initialIdStore } from '~/lib/stores/chatId';

const logger = createScopedLogger('WorkbenchController');

export function useWorkbenchController(isStreaming?: boolean) {
  const projectId = useStore(initialIdStore);
  const previews = useStore(workbenchStore.previews);
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const selectedFile = useStore(workbenchStore.selectedFile);
  const currentDocument = useStore(workbenchStore.currentDocument);
  const unsavedFiles = useStore(workbenchStore.unsavedFiles);
  const files = useStore(workbenchStore.files);
  const selectedView = useStore(workbenchStore.currentView);
  const following = useStore(workbenchStore.followingStreamedCode);
  const isSmallViewport = useViewport(1024);
  const [hasLoadedPreview, setHasLoadedPreview] = useState(false);

  useEffect(() => {
    if (previews.length) {
      workbenchStore.currentView.set('preview');
    }
  }, [previews.length]);

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
    void workbenchStore.saveCurrentDocument().catch((error) => {
      logger.error('Failed to update file content', error);
      toast.error('Failed to update file content');
    });
  }, []);

  return {
    close: () => workbenchStore.showWorkbench.set(false),
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
    projectId,
    selectedFile,
    selectedView,
    setSelectedView: (view: WorkbenchViewType) => workbenchStore.currentView.set(view),
    showWorkbench,
    unsavedFiles,
    scrollToDocAppend: following && isStreaming,
  };
}
