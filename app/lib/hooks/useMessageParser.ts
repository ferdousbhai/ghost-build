import { useCallback, useRef, useState } from 'react';
import { StreamingMessageParser } from 'ghostbuild-agent/message-parser';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { makePartId, type PartId } from 'ghostbuild-agent/partId';
import type { ArtifactAction } from 'ghostbuild-agent/types';
import { EXCLUDED_FILE_PATHS } from 'ghostbuild-agent/constants';
import {
  getToolInvocation,
  isMisparsedArtifactToolPart,
  isToolPart,
  type GhostbuildMessage,
  type GhostbuildPart,
} from 'ghostbuild-agent/ai-compat';

export const messageParser = new StreamingMessageParser({
  callbacks: {
    onArtifactOpen: (data) => {
      workbenchStore.showWorkbench.set(true);
      workbenchStore.addArtifact(data);
    },
    onArtifactClose: (data) => {
      workbenchStore.updateArtifact(data, { closed: true });
    },
    onActionOpen: (data) => {
      // Block writes to generated and infrastructure-owned files.
      if (isValidAction(data.action)) {
        workbenchStore.addAction(data);
      }
    },
    onActionClose: (data) => {
      if (data.action.type !== 'file') {
        workbenchStore.addAction(data);
      }
      if (isValidAction(data.action)) {
        workbenchStore.runAction(data);
      }
    },
    onActionStream: (data) => {
      if (isValidAction(data.action)) {
        workbenchStore.runAction(data, true);
      }
    },
  },
});

export type PartCache = Map<PartId, { original: Part; parsed: Part }>;

type Part = GhostbuildPart;

function isPartMaybeEqual(a: Part, b: Part): boolean {
  if (a.type === 'text' && b.type === 'text') {
    return a.text === b.text;
  }
  const aInvocation = getToolInvocation(a);
  const bInvocation = getToolInvocation(b);
  if (aInvocation && bInvocation) {
    if (aInvocation.state === 'result' && bInvocation.state === 'result') {
      return aInvocation.toolCallId === bInvocation.toolCallId;
    }
  }
  return false;
}

function processToolInvocationPart(partId: PartId, part: Part): Part | null {
  const toolInvocation = getToolInvocation(part);
  if (!toolInvocation) {
    return null;
  }
  workbenchStore.scheduleToolInvocation(toolInvocation, partId);
  return {
    type: 'tool-invocation',
    toolInvocation,
  };
}

export function processMessage(
  message: GhostbuildMessage,
  previousParts: PartCache,
): { message: GhostbuildMessage; hitRate: [number, number] } {
  if (message.role === 'user') {
    return { message, hitRate: [0, 0] };
  }
  if (!message.parts) {
    throw new Error('Message has no parts');
  }
  const parsedParts = [];
  let hits = 0;
  for (let i = 0; i < message.parts.length; i++) {
    const part = message.parts[i];
    const partId = makePartId(message.id, i);
    const cacheEntry = previousParts.get(partId);
    if (cacheEntry && isPartMaybeEqual(cacheEntry.original, part)) {
      parsedParts.push(cacheEntry.parsed);
      hits++;
      continue;
    }
    let newPart;
    switch (part.type) {
      case 'text': {
        let prevContent = '';
        if (cacheEntry && cacheEntry.parsed.type === 'text') {
          prevContent = cacheEntry.parsed.text;
        }
        const delta = messageParser.parse(partId, part.text);
        newPart = {
          type: 'text' as const,
          text: prevContent + delta,
        };
        break;
      }
      default: {
        if (isMisparsedArtifactToolPart(part)) {
          newPart = {
            type: 'text' as const,
            text: 'The builder returned an unsupported file-write block, so the changes were not applied. Please retry the request.',
          };
          break;
        }
        if (isToolPart(part)) {
          newPart = processToolInvocationPart(partId, part) ?? part;
          break;
        }
        newPart = part;
      }
    }
    parsedParts.push(newPart);
    previousParts.set(partId, { original: part, parsed: newPart });
  }
  return {
    message: {
      ...message,
      parts: parsedParts,
    },
    hitRate: [hits, message.parts.length],
  };
}

export function useMessageParser(partCache: PartCache) {
  const [parsedMessages, setParsedMessages] = useState<GhostbuildMessage[]>([]);

  const previousMessages = useRef<{ original: GhostbuildMessage; parsed: GhostbuildMessage }[]>([]);
  const previousParts = useRef<PartCache>(partCache);

  const parseMessages = useCallback((messages: GhostbuildMessage[]) => {
    const nextPrevMessages: { original: GhostbuildMessage; parsed: GhostbuildMessage }[] = [];
    const prevMessages = previousMessages.current;

    for (let i = 0; i < messages.length; i++) {
      const prev = prevMessages[i];
      const message = messages[i];
      if (!prev) {
        const { message: parsed } = processMessage(message, previousParts.current);
        nextPrevMessages.push({ original: message, parsed });
        continue;
      }
      if (prev.original === message) {
        nextPrevMessages.push(prev);
        continue;
      }
      const { message: parsed } = processMessage(message, previousParts.current);
      nextPrevMessages.push({ original: message, parsed });
    }

    const parsedMessagesChanged =
      prevMessages.length !== nextPrevMessages.length ||
      nextPrevMessages.some((message, index) => prevMessages[index]?.parsed !== message.parsed);

    previousMessages.current = nextPrevMessages;
    if (parsedMessagesChanged) {
      setParsedMessages(nextPrevMessages.map((p) => p.parsed));
    }
  }, []);

  return { parsedMessages, parseMessages };
}

function isValidAction(action: ArtifactAction): boolean {
  if (action.type === 'file') {
    return !EXCLUDED_FILE_PATHS.some((excludedPath) => action.filePath.includes(excludedPath));
  }
  return true;
}
