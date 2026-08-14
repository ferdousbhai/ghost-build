import { atom } from 'nanostores';
import type { TranscriptCheckpoint } from 'ghostbuild-agent/transcript';

export const chatCheckpointSyncState = atom<ChatCheckpointSyncState>({
  accountId: null,
  chatId: null,
  lastSync: 0,
  numFailures: 0,
  started: false,
  persistedMessageInfo: null,
  persistedTranscriptCheckpoint: null,
  subchatIndex: 0,
});

export type ChatCheckpointSyncState = {
  accountId: string | null;
  chatId: string | null;
  lastSync: number;
  numFailures: number;
  started: boolean;
  persistedMessageInfo: { messageIndex: number; partIndex: number } | null;
  persistedTranscriptCheckpoint: TranscriptCheckpoint | null;
  subchatIndex: number;
};

export type InitializedChatCheckpointSyncState = {
  accountId: string;
  chatId: string;
  lastSync: number;
  numFailures: number;
  started: boolean;
  persistedMessageInfo: { messageIndex: number; partIndex: number };
  persistedTranscriptCheckpoint: TranscriptCheckpoint | null;
  subchatIndex: number;
};
