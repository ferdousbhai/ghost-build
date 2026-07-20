import { useStore } from '@nanostores/react';
import { lazy, memo, Suspense } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  CodeMirrorEditor,
  type OnChangeCallback as OnEditorChange,
  type OnSaveCallback as OnEditorSave,
  type OnScrollCallback as OnEditorScroll,
  type OnWheelCallback as OnEditorWheel,
} from '~/components/editor/codemirror/CodeMirrorEditor';
import type { EditorDocument } from 'ghostbuild-agent/types';
import { PanelHeader } from '~/components/ui/PanelHeader';
import { PanelHeaderButton } from '~/components/ui/PanelHeaderButton';
import type { FileMap } from 'ghostbuild-agent/types';
import { themeStore } from '~/lib/stores/theme';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import { renderLogger } from 'ghostbuild-agent/utils/logger';
import { isMobile } from '~/utils/mobile';
import { FileBreadcrumb } from './FileBreadcrumb';
import { FileTree } from './FileTree';
import { DEFAULT_TERMINAL_SIZE } from './terminal/constants';
import { workbenchStore } from '~/lib/stores/workbench.client';
import type { TerminalInitializationOptions } from '~/types/terminal';
import { CheckIcon, ResetIcon } from '@radix-ui/react-icons';

interface EditorPanelProps {
  files?: FileMap;
  unsavedFiles?: Set<string>;
  editorDocument?: EditorDocument;
  selectedFile?: string | undefined;
  isStreaming?: boolean;
  scrollToDocAppend?: boolean;
  onEditorChange?: OnEditorChange;
  onEditorScroll?: OnEditorScroll;
  onEditorWheel?: OnEditorWheel;
  onFileSelect?: (value?: string) => void;
  onFileSave?: OnEditorSave;
  onFileReset?: () => void;
  terminalInitializationOptions?: TerminalInitializationOptions;
}

const DEFAULT_EDITOR_SIZE = 100 - DEFAULT_TERMINAL_SIZE;
const TerminalTabs = lazy(() => import('./terminal/TerminalTabs').then((module) => ({ default: module.TerminalTabs })));

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
  terminalInitializationOptions,
}: EditorPanelProps) {
  renderLogger.trace('EditorPanel');

  const theme = useStore(themeStore);
  const showTerminal = useStore(workbenchStore.showTerminal);

  const activeFileSegments = editorDocument?.filePath.split('/');
  const activeFileUnsaved = editorDocument !== undefined && unsavedFiles?.has(editorDocument.filePath);

  return (
    <PanelGroup direction="vertical">
      <Panel id="editor-workspace" order={1} defaultSize={showTerminal ? DEFAULT_EDITOR_SIZE : 100} minSize={20}>
        <PanelGroup direction="horizontal">
          <Panel id="file-tree" order={1} defaultSize={20} minSize={10} collapsible>
            <div className="flex h-full flex-col border-r">
              <PanelHeader>Files</PanelHeader>
              <FileTree
                className="h-full"
                files={files}
                hideRoot
                unsavedFiles={unsavedFiles}
                rootFolder={WORK_DIR}
                selectedFile={selectedFile}
                onFileSelect={onFileSelect}
              />
            </div>
          </Panel>
          <PanelResizeHandle />
          <Panel id="code-editor" order={2} className="flex flex-col" defaultSize={80} minSize={20}>
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
            <div className="h-full flex-1 overflow-hidden">
              <CodeMirrorEditor
                theme={theme}
                editable={!isStreaming && editorDocument !== undefined}
                doc={editorDocument}
                autoFocusOnDocumentChange={!isMobile()}
                scrollToDocAppend={!!scrollToDocAppend}
                onScroll={onEditorScroll}
                onWheel={onEditorWheel}
                onChange={onEditorChange}
                onSave={onFileSave}
              />
            </div>
          </Panel>
        </PanelGroup>
      </Panel>
      <PanelResizeHandle />
      <Suspense fallback={<TerminalPanelFallback showTerminal={showTerminal} />}>
        <TerminalTabs {...terminalInitializationOptions} />
      </Suspense>
    </PanelGroup>
  );
});

function TerminalPanelFallback({ showTerminal }: { showTerminal: boolean }) {
  return (
    <Panel
      id="terminal-panel"
      order={2}
      defaultSize={showTerminal ? DEFAULT_TERMINAL_SIZE : 0}
      minSize={10}
      collapsible
    />
  );
}
