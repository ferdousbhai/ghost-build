type BufferedCallback<T extends unknown[]> = ((...args: T) => void) & {
  flush: () => Promise<void>;
};

export function bufferWatchEvents<T extends unknown[]>(
  timeInMs: number,
  cb: (events: T[]) => unknown,
): BufferedCallback<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let events: T[] = [];

  // keep track of the processing of the previous batch so we can wait for it
  let processing: Promise<unknown> = Promise.resolve();

  const flush = async () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }

    const batch = events;
    events = [];
    if (batch.length > 0) {
      processing = processing.then(() => cb(batch));
    }
    await processing;
  };

  const buffered = (...args: T) => {
    events.push(args);

    if (timeoutId === undefined) {
      timeoutId = setTimeout(() => {
        void flush();
      }, timeInMs);
    }
  };

  buffered.flush = flush;
  return buffered;
}
