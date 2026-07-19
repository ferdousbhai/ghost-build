import type { WebContainerProcess } from '@webcontainer/api';

interface StreamOutputOptions {
  onOutput?: (data: string) => void;
  debounceMs?: number;
  maxOutputChars?: number;
}

export const MAX_RETAINED_PROCESS_OUTPUT_CHARS = 1_048_576;
export const PROCESS_OUTPUT_TRUNCATION_MARKER = '[... earlier process output truncated ...]\n';

export function appendProcessOutputTail(
  current: string,
  chunk: string,
  maxChars = MAX_RETAINED_PROCESS_OUTPUT_CHARS,
): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < PROCESS_OUTPUT_TRUNCATION_MARKER.length) {
    throw new Error('Process output limit is too small.');
  }
  const alreadyTruncated = current.startsWith(PROCESS_OUTPUT_TRUNCATION_MARKER);
  const priorTail = alreadyTruncated ? current.slice(PROCESS_OUTPUT_TRUNCATION_MARKER.length) : current;
  if (!alreadyTruncated && priorTail.length + chunk.length <= maxChars) {
    return priorTail + chunk;
  }
  const tailLimit = maxChars - PROCESS_OUTPUT_TRUNCATION_MARKER.length;
  const tail = chunk.length >= tailLimit ? chunk.slice(-tailLimit) : (priorTail + chunk).slice(-tailLimit);
  return PROCESS_OUTPUT_TRUNCATION_MARKER + tail;
}

export async function streamOutput(process: WebContainerProcess, options?: StreamOutputOptions) {
  let lastSaved = 0;
  let output = '';
  const outputComplete = process.output.pipeTo(
    new WritableStream({
      write(data) {
        output = appendProcessOutputTail(output, data, options?.maxOutputChars);
        const now = Date.now();
        if (!options?.debounceMs || now - lastSaved > options.debounceMs) {
          options?.onOutput?.(output);
          lastSaved = now;
        }
      },
    }),
  );
  options?.onOutput?.(output);
  const exitCode = await process.exit;
  await outputComplete;
  options?.onOutput?.(output);
  return { output, exitCode };
}
