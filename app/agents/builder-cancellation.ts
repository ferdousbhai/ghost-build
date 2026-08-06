type Wait = (durationMs: number) => Promise<void>;

export async function waitForCancellationBeforeDeadline(
  cancellation: Promise<void>,
  deadline: number,
  wait: Wait = (durationMs) => scheduler.wait(durationMs),
): Promise<void> {
  await Promise.race([
    cancellation,
    wait(Math.max(0, deadline - Date.now())).then(() => {
      throw new Error('Builder cancellation did not settle before the cancellation timeout.');
    }),
  ]);
}
