import type { GhostbuildMessage } from './ai-compat.js';
import { MAX_EPHEMERAL_CONTEXT_CHARACTERS } from './context-limits.js';
import { RelevantFilesContext } from './relevant-files-context.js';
import type { EditorDocument, FileMap } from './types.js';
import type { AbsolutePath } from './utils/workDir.js';

export class ChatContextManager {
  readonly #relevantFiles: RelevantFilesContext;

  constructor(
    getCurrentDocument: () => EditorDocument | undefined,
    getFiles: () => FileMap,
    getUserWrites: () => Map<AbsolutePath, number>,
  ) {
    this.#relevantFiles = new RelevantFilesContext(getCurrentDocument, getFiles, getUserWrites);
  }

  reset(): void {
    this.#relevantFiles.reset();
  }

  relevantFiles(
    messages: GhostbuildMessage[],
    id: string,
    maxRelevantFileCharacters = MAX_EPHEMERAL_CONTEXT_CHARACTERS,
  ): GhostbuildMessage {
    return this.#relevantFiles.build(messages, id, maxRelevantFileCharacters);
  }
}
