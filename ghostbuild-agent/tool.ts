/** Minimal executable tool shape shared by Cloudflare Computer and the Pi adapter. */
export type Tool = {
  type?: string;
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<unknown>;
};
