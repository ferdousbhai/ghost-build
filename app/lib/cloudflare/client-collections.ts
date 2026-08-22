const disposers = new Set<() => void | Promise<void>>();

export function registerClientCollectionDisposer(dispose: () => void | Promise<void>): () => void {
  disposers.add(dispose);
  return () => disposers.delete(dispose);
}

export async function disposeClientCollections(): Promise<void> {
  await Promise.allSettled([...disposers].map((dispose) => dispose()));
}
