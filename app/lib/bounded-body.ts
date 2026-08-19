export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

export class InvalidJsonBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJsonBodyError';
  }
}

export async function readBodyBytesWithLimit(
  message: Pick<Request, 'body' | 'headers'> | Pick<Response, 'body' | 'headers'>,
  maximumBytes: number,
  label: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = parseContentLength(message.headers);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw new PayloadTooLargeError(`${label} exceeds the maximum allowed size.`);
  }
  if (!message.body) {
    return new Uint8Array();
  }

  const reader = message.body.getReader();
  const chunks: Uint8Array<ArrayBufferLike>[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new PayloadTooLargeError(`${label} exceeds the maximum allowed size.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(new ArrayBuffer(totalBytes));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJsonBodyWithLimit(
  request: Pick<Request, 'body' | 'headers'>,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  const body = await readBodyBytesWithLimit(request, maximumBytes, label);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new InvalidJsonBodyError(`${label} must be valid UTF-8 JSON.`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new InvalidJsonBodyError(`${label} must be valid JSON.`);
  }
}

function parseContentLength(headers: Headers): number | null {
  const value = headers.get('content-length');
  if (value === null) {
    return null;
  }
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}
