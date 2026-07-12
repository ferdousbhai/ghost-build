export function createWorkersAI() {
  return () => {
    throw new Error("Workers AI is unavailable in Ghostbuild preview mode.");
  };
}
