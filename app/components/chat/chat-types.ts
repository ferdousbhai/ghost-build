import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { TranscriptCheckpoint, TranscriptIdentity } from 'ghostbuild-agent/transcript';
import type { PartCache } from '~/lib/hooks/useMessageParser';
import type { StreamStatus } from '~/lib/common/types';
import type { SubchatSummary } from './subchat-model';

export type StoreMessageHistory = (
  messages: GhostbuildMessage[],
  streamStatus: StreamStatus,
  transcriptCheckpoint: TranscriptCheckpoint | null,
) => void | Promise<void>;

export interface ChatProps {
  initialMessages: GhostbuildMessage[];
  partCache: PartCache;
  storeMessageHistory: StoreMessageHistory;
  initializeChat: () => Promise<boolean>;
  isReload: boolean;
  hadSuccessfulDeploy: boolean;
  subchats?: SubchatSummary[];
  allowGuest?: boolean;
  initialPrompt?: string;
  transcript: TranscriptIdentity;
  seedTranscript: boolean;
}
