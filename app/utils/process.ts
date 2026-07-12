import type { WebContainerProcess } from '@webcontainer/api';

interface StreamOutputOptions {
  onOutput?: (data: string) => void;
  debounceMs?: number;
}

export async function streamOutput(process: WebContainerProcess, options?: StreamOutputOptions) {
  let lastSaved = 0;
  let output = '';
  const outputComplete = process.output.pipeTo(
    new WritableStream({
      write(data) {
        output += data;
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
