import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { PartCache } from '~/lib/hooks/useMessageParser';
import type { StreamStatus } from '~/lib/common/types';

export type StoreMessageHistory = (messages: GhostbuildMessage[], streamStatus: StreamStatus) => void | Promise<void>;

export interface ChatProps {
  initialMessages: GhostbuildMessage[];
  partCache: PartCache;
  storeMessageHistory: StoreMessageHistory;
  initializeChat: () => Promise<boolean>;
  isReload: boolean;
  hadSuccessfulDeploy: boolean;
  subchats?: { subchatIndex: number; updatedAt: number; description?: string }[];
  allowGuest?: boolean;
  initialPrompt?: string;
  resetMessagesOnSubchatChange?: boolean;
}
