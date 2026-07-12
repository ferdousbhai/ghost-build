export function useAgentChat() {
  return {
    messages: [],
    sendMessage: () => {},
    clearHistory: () => {},
    status: "ready",
    stop: () => {},
    isRecovering: false,
  };
}
