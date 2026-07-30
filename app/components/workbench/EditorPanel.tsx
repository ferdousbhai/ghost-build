import { useStore } from '@nanostores/react';
import { memo } from 'react';
import {
  CodeMirrorEditor,
  type OnChangeCallback as OnEditorChange,
  type OnSaveCallback as OnEditorSave,
  type OnScrollCallback as OnEditorScroll,
  type OnWheelCallback as OnEditorWheel,
} from '~/components/editor/codemirror/CodeMirrorEditor';
import { PanelHeader } from '~/components/ui/PanelHeader';
import { PanelHeaderButton } from '~/components/ui/PanelHeaderButton';
import type { EditorDocument, FileMap } from 'ghostbuild-agent/types';
import { themeStore } from '~/lib/stores/theme';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import { renderLogger } from 'ghostbuild-agent/utils/logger';
import { isMobile } from '~/utils/mobile';
import { FileBreadcrumb } from './FileBreadcrumb';
import { FileTree } from './FileTree';
import { CheckIcon, ResetIcon } from '@radix-ui/react-icons';

interface EditorPanelProps {
  files?: FileMap;
  unsavedFiles?: Set<string>;
  editorDocument?: EditorDocument;
  selectedFile?: string;
  isStreaming?: boolean;
  scrollToDocAppend?: boolean;
  onEditorChange?: OnEditorChange;
  onEditorScroll?: OnEditorScroll;
  onEditorWheel?: OnEditorWheel;
  onFileSelect?: (value?: string) => void;
  onFileSave?: OnEditorSave;
  onFileReset?: () => void;
}

export const EditorPanel = memo(function EditorPanel({
  files,
  unsavedFiles,
  editorDocument,
  selectedFile,
  isStreaming,
  scrollToDocAppend,
  onFileSelect,
  onEditorChange,
  onEditorScroll,
  onEditorWheel,
  onFileSave,
  onFileReset,
}: EditorPanelProps) {
  renderLogger.trace('EditorPanel');
  const theme = useStore(themeStore);
  const activeFileSegments = editorDocument?.filePath.split('/');
  const activeFileUnsaved = editorDocument !== undefined && unsavedFiles?.has(editorDocument.filePath);

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(10rem,22%)_1fr] max-sm:grid-cols-1 max-sm:grid-rows-[minmax(8rem,30%)_1fr]">
      <aside className="flex min-h-0 flex-col border-r border-border-transparent max-sm:border-r-0 max-sm:border-b">
        <PanelHeader>Durable files</PanelHeader>
        <FileTree
          className="h-full min-h-0"
          files={files}
          hideRoot
          unsavedFiles={unsavedFiles}
          rootFolder={WORK_DIR}
          selectedFile={selectedFile}
          onFileSelect={onFileSelect}
        />
      </aside>
      <section className="flex min-h-0 flex-col">
        <PanelHeader className="overflow-x-auto">
          {(activeFileSegments?.length ?? 0) > 0 && (
            <div className="flex flex-1 items-center text-sm">
              <FileBreadcrumb pathSegments={activeFileSegments} files={files} onFileSelect={onFileSelect} />
              {activeFileUnsaved && (
                <div className="-mr-1.5 ml-auto flex gap-1">
                  <PanelHeaderButton onClick={onFileSave}>
                    <CheckIcon />
                    Save
                  </PanelHeaderButton>
                  <PanelHeaderButton onClick={onFileReset}>
                    <ResetIcon />
                    Reset
                  </PanelHeaderButton>
                </div>
              )}
            </div>
          )}
        </PanelHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodeMirrorEditor
            theme={theme}
            editable={!isStreaming && editorDocument !== undefined}
            doc={editorDocument}
            autoFocusOnDocumentChange={!isMobile()}
            scrollToDocAppend={Boolean(scrollToDocAppend)}
            onScroll={onEditorScroll}
            onWheel={onEditorWheel}
            onChange={onEditorChange}
            onSave={onFileSave}
          />
        </div>
      </section>
    </div>
  );
});
