/**
 * Creates a function that samples calls at regular intervals and captures trailing calls.
 * - Drops calls that occur between sampling intervals
 * - Takes one call per sampling interval if available
 * - Captures the last call if no call was made during the interval
 *
 * @param fn The function to sample
 * @param sampleInterval How often to sample calls (in ms)
 * @returns The sampled function
 */
type SampledFunction<Args extends unknown[]> = ((...args: Args) => void) & {
  cancel(): void;
};

export function createSampler<Args extends unknown[]>(
  fn: (...args: Args) => void,
  sampleInterval: number,
): SampledFunction<Args> {
  let lastArgs: Args | null = null;
  let lastTime = Number.NEGATIVE_INFINITY;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const sampled = function (...args: Args) {
    const now = Date.now();
    lastArgs = args;

    if (now - lastTime < sampleInterval) {
      if (!timeout) {
        timeout = setTimeout(
          () => {
            timeout = null;
            lastTime = Date.now();

            if (lastArgs) {
              fn(...lastArgs);
              lastArgs = null;
            }
          },
          sampleInterval - (now - lastTime),
        );
      }

      return;
    }

    lastTime = now;
    fn(...args);
    lastArgs = null;
  };

  sampled.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    lastArgs = null;
    lastTime = Number.NEGATIVE_INFINITY;
  };

  return sampled;
}
