import type { z } from 'zod';
import type { dataOperationArgSchemas } from './data-operation-schemas';
import type { TranscriptIdentity } from 'ghostbuild-agent/transcript';
import type { ChatHistoryCursor, DataPage, SubchatCursor } from './data-pagination';

type ChatSummary = {
  initialId: string;
  urlId?: string;
  description?: string;
  timestamp: string;
  snapshotId?: string;
  subchatIndex: number;
  transcript: TranscriptIdentity;
};

export type ChatHistorySummary = {
  /*
   * ID should be the urlId (if it's set) or the initialId, and callers should be able
   * to handle either.
   */
  id: string;
  initialId: string;
  urlId?: string;
  description?: string;
  timestamp: string;
};

export type SubchatSummary = {
  subchatIndex: number;
  description?: string;
  updatedAt: number;
  transcript: TranscriptIdentity;
};

export type CurrentSocialShare = {
  isShared: boolean;
  code: string;
  thumbnailUrl: string | null;
};

export type SocialShare = {
  description: string | null;
  code: string;
  thumbnailUrl: string | null;
};

type DataOperationResults = {
  'messages.earliestRewindableMessageRank': number | null;
  'messages.get': ChatSummary | null;
  'messages.getAll': DataPage<ChatHistorySummary, ChatHistoryCursor>;
  'messages.initializeChat': { created: boolean };
  'messages.discardEmptyChat': null;
  'messages.remove': { kind: 'success' };
  'messages.rewindChat': null;
  'messages.setDescription': null;
  'share.clone': { id: string; description?: string };
  'share.create': { code: string };
  'share.getShareDescription': { description?: string };
  'snapshot.getSnapshotUrl': string | null;
  'socialShare.getCurrentSocialShare': CurrentSocialShare | null;
  'socialShare.getSocialShare': SocialShare;
  'socialShare.share': string;
  'subchats.create': number;
  'subchats.get': DataPage<SubchatSummary, SubchatCursor>;
  'subchats.setDescription': null;
};

export type DataOperationPath = keyof typeof dataOperationArgSchemas;
export type DataOperationArgs<Path extends DataOperationPath> = z.infer<(typeof dataOperationArgSchemas)[Path]>;
export type DataOperationResult<Path extends DataOperationPath> = DataOperationResults[Path];
type DataApiNamespace = Record<string, DataOperationPath>;

export const api = {
  messages: {
    earliestRewindableMessageRank: 'messages.earliestRewindableMessageRank',
    get: 'messages.get',
    getAll: 'messages.getAll',
    initializeChat: 'messages.initializeChat',
    discardEmptyChat: 'messages.discardEmptyChat',
    remove: 'messages.remove',
    rewindChat: 'messages.rewindChat',
    setDescription: 'messages.setDescription',
  },
  share: {
    clone: 'share.clone',
    create: 'share.create',
    getShareDescription: 'share.getShareDescription',
  },
  snapshot: {
    getSnapshotUrl: 'snapshot.getSnapshotUrl',
  },
  socialShare: {
    getCurrentSocialShare: 'socialShare.getCurrentSocialShare',
    getSocialShare: 'socialShare.getSocialShare',
    share: 'socialShare.share',
  },
  subchats: {
    create: 'subchats.create',
    get: 'subchats.get',
    setDescription: 'subchats.setDescription',
  },
} as const satisfies Record<string, DataApiNamespace>;
