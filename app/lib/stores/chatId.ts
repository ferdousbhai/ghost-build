/* All chats eventually have two IDs:
 * - The initialId is the ID of the chat when it is first created (a UUID)
 * - The urlId is the ID of the chat that is displayed in the URL. This is a human-friendly ID that is
 *   displayed in the URL.
 *
 * Server-side functions accept either, so we call their union a `chatId`.
 */
import { useStore } from '@nanostores/react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { useCallback } from 'react';
import { atom, computed, map } from 'nanostores';

const logger = createScopedLogger('ChatId');

/*
 * When loading the homepage, we set `pageLoadMixedId` to a randomly generated initialId.
 * When loading `/chat`, the user may provide either an initialId or a urlId.
 */
const pageLoadChatId = atom<string | undefined>(undefined);

export function getPageLoadChatId() {
  return pageLoadChatId.get();
}

export function setPageLoadChatId(chatId: string) {
  const existing = pageLoadChatId.get();
  if (existing === undefined) {
    pageLoadChatId.set(chatId);
    return;
  }

  if (existing !== chatId) {
    throw new Error(`pageLoadChatId already set to ${existing} but trying to set to ${chatId}`);
  }
}

/*
 * If the user loads `/chat` with a urlId, we only know the `initialId` after we're done
 * loading the chat.
 */
const knownInitialId = atom<string | undefined>(undefined);

export function getKnownInitialId() {
  return knownInitialId.get();
}

export function setKnownInitialId(initialId: string) {
  knownInitialId.set(initialId);
}

// This is useful in places where we want a unique ID (e.g. logs) instead of the
// more human-friendly `urlId`, which is only unique within the current session.
export const initialIdStore = computed([pageLoadChatId, knownInitialId], (pageLoadChatId, knownInitialId) => {
  if (knownInitialId !== undefined) {
    return knownInitialId;
  }
  if (pageLoadChatId === undefined) {
    throw new Error('initialIdStore used before pageLoadChatId was set');
  }
  return pageLoadChatId;
});

/*
 * Existing chats can have a human-friendly `urlId`, which is learned while loading.
 */
const knownUrlId = atom<string | undefined>(undefined);

export function setKnownUrlId(urlId: string) {
  if (!knownUrlId.get()) {
    knownUrlId.set(urlId);
  }
}

export const chatIdStore = computed(
  [pageLoadChatId, knownInitialId, knownUrlId],
  (pageLoadChatId, knownInitialId, knownUrlId) => {
    if (knownUrlId !== undefined) {
      return knownUrlId;
    }
    if (knownInitialId !== undefined) {
      return knownInitialId;
    }
    if (pageLoadChatId === undefined) {
      throw new Error('chatIdStore used before pageLoadChatId was set');
    }
    return pageLoadChatId;
  },
);

export function useChatId() {
  return useStore(chatIdStore);
}

export function chatUrlMask(chatId: string) {
  return {
    to: '/chat/$id',
    params: { id: chatId },
    unmaskOnReload: true,
  } as const;
}

/**
 * Keep the live route mounted while publishing its resumable chat URL.
 *
 * A homepage build continues to run on the `/` route in memory, while an
 * existing chat continues to run against the ID it loaded with. TanStack
 * Router's route mask keeps that runtime location and the displayed URL in
 * sync without bypassing router history.
 */
export function useNavigateToChat() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { id?: string };
  const currentChatRouteId = params.id;

  return useCallback(
    async (chatId: string): Promise<void> => {
      try {
        if (currentChatRouteId === chatId) {
          return;
        }

        const commonOptions = {
          mask: chatUrlMask(chatId),
          replace: true,
          resetScroll: false,
          ignoreBlocker: true,
        } as const;

        if (currentChatRouteId) {
          await navigate({
            to: '/chat/$id',
            params: { id: currentChatRouteId },
            ...commonOptions,
          });
          return;
        }

        await navigate({
          to: '/',
          ...commonOptions,
        });
      } catch (error) {
        logger.warn('Unable to publish the resumable chat URL', error);
      }
    },
    [currentChatRouteId, navigate],
  );
}

export const chatStore = map({
  started: false,
  aborted: false,
  showChat: true,
});
