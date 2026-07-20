export type ChatRow = {
  id: string;
  creator_id: string;
  initial_id: string;
  url_id: string | null;
  description: string | null;
  timestamp: string;
  snapshot_key: string | null;
  last_message_rank: number | null;
  last_subchat_index: number;
  is_deleted: number;
};

export type ChatMessageStateRow = {
  id: string;
  chat_id: string;
  storage_key: string | null;
  subchat_index: number;
  last_message_rank: number;
  part_index: number;
  snapshot_key: string | null;
  description: string | null;
  created_at: number;
  transcript_generation: number;
  transcript_revision: number;
  transcript_digest: string | null;
};

export type ChatTranscriptRow = {
  chat_id: string;
  subchat_index: number;
  generation: number;
  agent_name: string;
  head_revision: number;
  head_digest: string | null;
  head_message_count: number;
  parent_subchat_index: number | null;
  parent_generation: number | null;
  parent_revision: number | null;
  transition_token: string;
  created_at: number;
  updated_at: number;
};

export type ShareRow = {
  id: string;
  chat_id: string;
  snapshot_key: string;
  code: string;
  chat_history_key: string | null;
  last_message_rank: number;
  last_subchat_index: number;
  part_index: number | null;
  description: string | null;
};

export type SocialShareRow = {
  id: string;
  chat_id: string;
  code: string;
  thumbnail_image_key: string | null;
  is_shared: number;
};
