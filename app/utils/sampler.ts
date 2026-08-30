type SampledFunction<Args extends unknown[]> = ((...args: Args) => void) & {
  cancel(): void;
};

/** Invoke immediately at most once per interval, then invoke the latest suppressed call at the trailing edge. */
export function createSampler<Args extends unknown[]>(
  fn: (...args: Args) => void,
  intervalMs: number,
): SampledFunction<Args> {
  let latestArgs: Args | null = null;
  let lastInvocationTime = Number.NEGATIVE_INFINITY;
  let trailingTimeout: ReturnType<typeof setTimeout> | null = null;

  const sampled = function (...args: Args) {
    const now = Date.now();
    latestArgs = args;

    if (now - lastInvocationTime < intervalMs) {
      if (!trailingTimeout) {
        trailingTimeout = setTimeout(
          () => {
            trailingTimeout = null;
            lastInvocationTime = Date.now();

            if (latestArgs) {
              fn(...latestArgs);
              latestArgs = null;
            }
          },
          intervalMs - (now - lastInvocationTime),
        );
      }

      return;
    }

    lastInvocationTime = now;
    fn(...args);
    latestArgs = null;
  };

  sampled.cancel = () => {
    if (trailingTimeout) {
      clearTimeout(trailingTimeout);
      trailingTimeout = null;
    }
    latestArgs = null;
    lastInvocationTime = Number.NEGATIVE_INFINITY;
  };

  return sampled;
}
