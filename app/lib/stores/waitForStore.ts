type ReadableStore<T> = {
  get(): T;
  listen(listener: (value: T) => void): () => void;
};

export async function waitForStoreCondition<T>(
  store: ReadableStore<T>,
  condition: (value: T) => boolean,
): Promise<void> {
  await waitForStoreValue(store, (value) => (condition(value) ? true : null));
}

export async function waitForStoreValue<T, TResult>(
  store: ReadableStore<T>,
  selectValue: (value: T) => TResult | null | undefined,
): Promise<TResult> {
  const value = selectValue(store.get());
  if (value !== null && value !== undefined) {
    return value;
  }

  return new Promise<TResult>((resolve, reject) => {
    const unlisten = store.listen((storeValue) => {
      try {
        const value = selectValue(storeValue);
        if (value !== null && value !== undefined) {
          unlisten();
          resolve(value);
        }
      } catch (error) {
        unlisten();
        reject(error);
      }
    });
  });
}
