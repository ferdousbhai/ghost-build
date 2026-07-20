import { atom } from 'nanostores';
import type { TranscriptCheckpoint } from 'ghostbuild-agent/transcript';

export const chatSyncState = atom<BackupSyncState>({
  chatId: null,
  lastSync: 0,
  numFailures: 0,
  started: false,
  persistedMessageInfo: null,
  persistedTranscriptCheckpoint: null,
  savedFileUpdateCounter: null,
  subchatIndex: 0,
});

export type BackupSyncState = {
  chatId: string | null;
  lastSync: number;
  numFailures: number;
  started: boolean;
  persistedMessageInfo: { messageIndex: number; partIndex: number } | null;
  persistedTranscriptCheckpoint: TranscriptCheckpoint | null;
  savedFileUpdateCounter: number | null;
  subchatIndex: number;
};

export type InitialBackupSyncState = {
  chatId: string;
  lastSync: number;
  numFailures: number;
  started: boolean;
  persistedMessageInfo: { messageIndex: number; partIndex: number };
  persistedTranscriptCheckpoint: TranscriptCheckpoint | null;
  savedFileUpdateCounter: number;
  subchatIndex: number;
};
