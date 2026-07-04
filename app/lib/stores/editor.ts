import { atom, computed, map, type MapStore, type WritableAtom } from 'nanostores';
import type { EditorDocument, ScrollPosition } from 'ghostbuild-agent/types';
import type { AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import type { FileMap } from 'ghostbuild-agent/types';
import type { FilesStore } from '~/lib/stores/files';

type EditorDocuments = Record<string, EditorDocument>;

type SelectedFile = WritableAtom<string | undefined>;

export class EditorStore {
  #filesStore: FilesStore;

  selectedFile: SelectedFile = import.meta.hot?.data.selectedFile ?? atom<AbsolutePath | undefined>();
  documents: MapStore<EditorDocuments> = import.meta.hot?.data.documents ?? map({});
  followingStreamedCode = atom<boolean>(true);

  currentDocument = computed([this.documents, this.selectedFile], (documents, selectedFile) =>
    selectedFile ? documents[selectedFile] : undefined,
  );

  constructor(filesStore: FilesStore) {
    this.#filesStore = filesStore;

    if (import.meta.hot) {
      import.meta.hot.data.documents = this.documents;
      import.meta.hot.data.selectedFile = this.selectedFile;
    }
  }

  setDocuments(files: FileMap) {
    const previousDocuments = this.documents.value;
    const documents: EditorDocuments = {};

    for (const [filePath, dirent] of Object.entries(files)) {
      if (dirent === undefined || dirent.type === 'folder') {
        continue;
      }

      const absolutePath = filePath as AbsolutePath;

      documents[filePath] = {
        value: dirent.content,
        isBinary: dirent.isBinary,
        filePath: absolutePath,
        scroll: previousDocuments?.[filePath]?.scroll,
      };
    }

    this.documents.set(documents);
  }

  setSelectedFile(filePath: AbsolutePath | undefined) {
    this.selectedFile.set(filePath);
  }

  updateScrollPosition(filePath: string, position: ScrollPosition) {
    const documents = this.documents.get();
    const documentState = documents[filePath];

    if (!documentState) {
      return;
    }

    this.documents.setKey(filePath, {
      ...documentState,
      scroll: position,
    });
  }

  updateFile(filePath: string, newContent: string) {
    const documents = this.documents.get();
    const documentState = documents[filePath];

    if (!documentState) {
      return;
    }

    const currentContent = documentState.value;
    const contentChanged = currentContent !== newContent;

    if (contentChanged) {
      this.documents.setKey(filePath, {
        ...documentState,
        value: newContent,
      });
    }
  }
}
