export type ChatRow = {
  id: string;
  creator_id: string;
  initial_id: string;
  description: string | null;
  timestamp: string;
  last_subchat_index: number;
  is_deleted: number;
};

export type ChatTranscriptRow = {
  chat_id: string;
  subchat_index: number;
  generation: number;
  agent_name: string;
  head_revision: number;
  head_digest: string | null;
  head_message_count: number;
  last_message_rank: number;
  part_index: number;
  description: string | null;
  parent_subchat_index: number | null;
  parent_generation: number | null;
  parent_revision: number | null;
  transition_token: string;
  created_at: number;
  updated_at: number;
};
