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
export function createSampler<Args extends unknown[]>(
  fn: (...args: Args) => unknown,
  sampleInterval: number,
): (...args: Args) => void {
  let lastArgs: Args | null = null;
  let lastTime = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return function sampled(...args: Args) {
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
}
