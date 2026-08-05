import { useCallback, useRef, useState } from 'react';
import { makePartId, type PartId } from 'ghostbuild-agent/partId';
import { getToolInvocation, isToolPart, type GhostbuildMessage, type GhostbuildPart } from 'ghostbuild-agent/ai-compat';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';

export type PartCache = Map<PartId, { original: Part; parsed: Part }>;

type Part = GhostbuildPart;

function isPartMaybeEqual(a: Part, b: Part): boolean {
  if (a.type === 'text' && b.type === 'text') {
    return a.text === b.text;
  }
  const aInvocation = getToolInvocation(a);
  const bInvocation = getToolInvocation(b);
  if (aInvocation && bInvocation) {
    const aState = (aInvocation as { state?: unknown }).state;
    const bState = (bInvocation as { state?: unknown }).state;
    if (
      typeof aState === 'string' &&
      typeof bState === 'string' &&
      aState.startsWith('output-') &&
      bState.startsWith('output-')
    ) {
      return aInvocation.toolCallId === bInvocation.toolCallId && aInvocation.state === bInvocation.state;
    }
  }
  return false;
}

function recordToolPart(partId: PartId, part: Part): void {
  const toolInvocation = getToolInvocation(part);
  if (!toolInvocation) {
    return;
  }
  toolActivityStore.record(partId, toolInvocation);
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
    if (isToolPart(part)) {
      recordToolPart(partId, part);
    }
    const newPart = part;
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

export function useProcessedMessages(partCache: PartCache) {
  const [parsedMessages, setParsedMessages] = useState<GhostbuildMessage[]>([]);

  const previousMessages = useRef<{ original: GhostbuildMessage; parsed: GhostbuildMessage }[]>([]);
  const previousParts = useRef<PartCache>(partCache);

  const processMessages = useCallback((messages: GhostbuildMessage[]) => {
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
      setParsedMessages(nextPrevMessages.map((message) => message.parsed));
    }
  }, []);

  return { parsedMessages, processMessages };
}
