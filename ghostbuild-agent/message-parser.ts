import type { PartId } from './partId.js';
import type { ArtifactAction, ArtifactData, FileAction } from './types.js';
import { createScopedLogger } from './utils/logger.js';
import { getRelativePath } from './utils/workDir.js';
import { unreachable } from './utils/unreachable.js';

const ARTIFACT_TAG_OPEN = '<boltArtifact';
const ARTIFACT_TAG_CLOSE = '</boltArtifact>';
const ARTIFACT_ACTION_TAG_OPEN = '<boltAction';
const ARTIFACT_ACTION_TAG_CLOSE = '</boltAction>';

const logger = createScopedLogger('MessageParser');

export interface ArtifactCallbackData extends ArtifactData {
  partId: PartId;
}

export interface ActionCallbackData {
  artifactId: string;
  partId: PartId;
  actionId: string;
  action: ArtifactAction;
}

export type ArtifactCallback = (data: ArtifactCallbackData) => void;
export type ActionCallback = (data: ActionCallbackData) => void;

interface ParserCallbacks {
  onArtifactOpen?: ArtifactCallback;
  onArtifactClose?: ArtifactCallback;
  onActionOpen?: ActionCallback;
  onActionStream?: ActionCallback;
  onActionClose?: ActionCallback;
}

interface ElementFactoryProps {
  partId: PartId;
}

type ElementFactory = (props: ElementFactoryProps) => string;

interface StreamingMessageParserOptions {
  callbacks?: ParserCallbacks;
  artifactElement?: ElementFactory;
}

interface MessageState {
  position: number;
  insideArtifact: boolean;
  insideAction: boolean;
  currentArtifact?: ArtifactData;
  currentAction: FileAction | null;
  actionId: number;
  hasCreatedArtifact: boolean;
}

/** Compatibility parser for file actions stored in pre-tool-call chat transcripts. */
export class LegacyBoltMessageParser {
  #messages = new Map<string, MessageState>();

  constructor(private readonly options: StreamingMessageParserOptions = {}) {}

  parse(partId: PartId, input: string) {
    let state = this.#messages.get(partId);

    if (!state) {
      state = {
        position: 0,
        insideAction: false,
        insideArtifact: false,
        currentAction: null,
        actionId: 0,
        hasCreatedArtifact: false,
      };

      this.#messages.set(partId, state);
    }

    let output = '';
    let i = state.position;
    let earlyBreak = false;

    while (i < input.length) {
      if (state.insideArtifact) {
        const currentArtifact = state.currentArtifact;

        if (currentArtifact === undefined) {
          unreachable('Artifact not initialized');
        }

        if (state.insideAction) {
          const closeIndex = input.indexOf(ARTIFACT_ACTION_TAG_CLOSE, i);
          const currentAction = state.currentAction;

          if (!currentAction) {
            if (closeIndex === -1) {
              break;
            }
            state.insideAction = false;
            i = closeIndex + ARTIFACT_ACTION_TAG_CLOSE.length;
            continue;
          }

          if (closeIndex !== -1) {
            const actionContent = input.slice(i, closeIndex);

            let content = actionContent.trim();

            // Remove markdown code block syntax if present and file is not markdown
            if (!currentAction.filePath.endsWith('.md')) {
              content = stripMarkdownFence(content);
              content = cleanEscapedTags(content);
            }

            content += '\n';

            currentAction.content = content;

            this.options.callbacks?.onActionClose?.({
              artifactId: currentArtifact.id,
              partId,

              /**
               * We decrement the id because it's been incremented already
               * when `onActionOpen` was emitted to make sure the ids are
               * the same.
               */
              actionId: String(state.actionId - 1),

              action: currentAction,
            });

            state.insideAction = false;
            state.currentAction = null;

            i = closeIndex + ARTIFACT_ACTION_TAG_CLOSE.length;
          } else {
            let content = input.slice(i);

            if (!currentAction.filePath.endsWith('.md')) {
              content = stripMarkdownFence(content);
              content = cleanEscapedTags(content);
            }

            this.options.callbacks?.onActionStream?.({
              artifactId: currentArtifact.id,
              partId,
              actionId: String(state.actionId - 1),
              action: { ...currentAction, content },
            });

            break;
          }
        } else {
          const actionOpenIndex = input.indexOf(ARTIFACT_ACTION_TAG_OPEN, i);
          const artifactCloseIndex = input.indexOf(ARTIFACT_TAG_CLOSE, i);

          if (actionOpenIndex !== -1 && (artifactCloseIndex === -1 || actionOpenIndex < artifactCloseIndex)) {
            const actionEndIndex = input.indexOf('>', actionOpenIndex);

            if (actionEndIndex !== -1) {
              state.insideAction = true;

              state.currentAction = parseFileActionTag(input.slice(actionOpenIndex, actionEndIndex + 1));

              if (state.currentAction) {
                this.options.callbacks?.onActionOpen?.({
                  artifactId: currentArtifact.id,
                  partId,
                  actionId: String(state.actionId++),
                  action: state.currentAction,
                });
              }

              i = actionEndIndex + 1;
            } else {
              break;
            }
          } else if (artifactCloseIndex !== -1) {
            this.options.callbacks?.onArtifactClose?.({ partId, ...currentArtifact });

            state.insideArtifact = false;
            state.currentArtifact = undefined;

            i = artifactCloseIndex + ARTIFACT_TAG_CLOSE.length;
          } else {
            break;
          }
        }
      } else if (input[i] === '<' && input[i + 1] !== '/') {
        let j = i;
        let potentialTag = '';

        while (j < input.length && potentialTag.length < ARTIFACT_TAG_OPEN.length) {
          potentialTag += input[j];

          if (potentialTag === ARTIFACT_TAG_OPEN) {
            const nextChar = input[j + 1];

            if (nextChar && nextChar !== '>' && nextChar !== ' ') {
              output += input.slice(i, j + 1);
              i = j + 1;
              break;
            }

            const openTagEnd = input.indexOf('>', j);

            if (openTagEnd !== -1) {
              const artifactTag = input.slice(i, openTagEnd + 1);
              const attributes = parseTagAttributes(artifactTag);
              const artifactTitle = attributes.title ?? '';
              const type = attributes.type;
              const artifactId = attributes.id ?? '';

              if (!artifactTitle) {
                logger.warn('Artifact title missing');
              }

              if (!artifactId) {
                logger.warn('Artifact id missing');
              }

              state.insideArtifact = true;

              const currentArtifact = {
                id: artifactId,
                title: artifactTitle,
                type,
              } satisfies ArtifactData;

              state.currentArtifact = currentArtifact;

              this.options.callbacks?.onArtifactOpen?.({ partId, ...currentArtifact });

              // Sometimes the agent creates multiple artifacts in a single part,
              // which we don't want. In order to prevent these rendering multiple times,
              // we'll only add the element for the artifact once.
              if (!state.hasCreatedArtifact) {
                const artifactFactory = this.options.artifactElement ?? createArtifactElement;

                output += artifactFactory({ partId });
                state.hasCreatedArtifact = true;
              }

              i = openTagEnd + 1;
            } else {
              earlyBreak = true;
            }

            break;
          } else if (!ARTIFACT_TAG_OPEN.startsWith(potentialTag)) {
            output += input.slice(i, j + 1);
            i = j + 1;
            break;
          }

          j++;
        }

        if (j === input.length && ARTIFACT_TAG_OPEN.startsWith(potentialTag)) {
          break;
        }
      } else {
        output += input[i];
        i++;
      }

      if (earlyBreak) {
        break;
      }
    }

    state.position = i;

    return output;
  }

  reset() {
    this.#messages.clear();
  }
}

/** @deprecated New responses use AI SDK tool parts; retained for old transcripts. */
export { LegacyBoltMessageParser as StreamingMessageParser };

const createArtifactElement: ElementFactory = (props) => {
  const elementProps = [
    'class="__boltArtifact__"',
    ...Object.entries(props).map(([key, value]) => {
      return `data-${camelToDashCase(key)}=${JSON.stringify(value)}`;
    }),
  ];

  return `<div ${elementProps.join(' ')}></div>`;
};

function camelToDashCase(input: string) {
  return input.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function stripMarkdownFence(content: string) {
  const codeBlockRegex = /^\s*```\w*\n([\s\S]*?)\n\s*```\s*$/;
  const match = content.match(codeBlockRegex);

  if (match) {
    return match[1]; // Remove common leading 4-space indent
  }

  return content;
}

function parseFileActionTag(tag: string): FileAction | null {
  const attributes = parseTagAttributes(tag);
  if (attributes.type !== 'file') {
    logger.debug(`Ignoring unsupported legacy action type '${attributes.type ?? 'missing'}'`);
    return null;
  }
  if (!attributes.filePath) {
    logger.warn('Ignoring legacy file action without a path');
    return null;
  }
  return {
    type: 'file',
    filePath: getRelativePath(attributes.filePath),
    content: '',
  };
}

function parseTagAttributes(tag: string): Record<string, string> {
  return Object.fromEntries(Array.from(tag.matchAll(/([\w:-]+)="([^"]*)"/g), ([, key, value]) => [key, value]));
}

function cleanEscapedTags(content: string) {
  return content.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
