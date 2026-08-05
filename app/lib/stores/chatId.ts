/* A chat's immutable initial ID is its route, persistence, and agent identity. */
import { useStore } from '@nanostores/react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { useCallback } from 'react';
import { atom, computed, map } from 'nanostores';

const logger = createScopedLogger('ChatId');

/* The homepage creates an ID; an existing route supplies it. */
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

/* Confirm the server-owned identity after chat metadata loads. */
const knownInitialId = atom<string | undefined>(undefined);

export function getKnownInitialId() {
  return knownInitialId.get();
}

export function setKnownInitialId(initialId: string) {
  knownInitialId.set(initialId);
}

export const chatIdStore = computed([pageLoadChatId, knownInitialId], (pageLoadChatId, knownInitialId) => {
  if (knownInitialId !== undefined) {
    return knownInitialId;
  }
  if (pageLoadChatId === undefined) {
    throw new Error('chatIdStore used before pageLoadChatId was set');
  }
  return pageLoadChatId;
});

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
