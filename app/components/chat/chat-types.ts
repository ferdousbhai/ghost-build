import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { TranscriptIdentity } from 'ghostbuild-agent/transcript';
import type { PartCache } from '~/lib/hooks/useProcessedMessages';
import type { SubchatSummary } from './subchat-model';

export interface ChatProps {
  initialMessages: GhostbuildMessage[];
  partCache: PartCache;
  initializeChat: () => Promise<{ created: boolean }>;
  discardEmptyChat: () => Promise<void>;
  onBuilderRequestStart: () => void;
  subchats?: SubchatSummary[];
  initialPrompt?: string;
  transcript: TranscriptIdentity;
}
