import { PayloadTooLargeError, readBodyBytesWithLimit } from './bounded-body';

const MAX_BOUNDARY_BYTES = 200;
const MAX_PART_HEADER_BYTES = 8 * 1024;
const CRLF = new Uint8Array([13, 10]);
const DOUBLE_CRLF = new Uint8Array([13, 10, 13, 10]);

export class InvalidMultipartBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMultipartBodyError';
  }
}

type MultipartFieldLimit = {
  kind: 'file' | 'text';
  maximumBytes: number;
};

export async function readMultipartBodyWithLimits(
  request: Request,
  options: {
    label: string;
    maximumBytes: number;
    fields: Readonly<Record<string, MultipartFieldLimit>>;
  },
): Promise<Map<string, Blob | string>> {
  const boundary = multipartBoundary(request.headers.get('content-type'), options.label);
  const body = await readBodyBytesWithLimit(request, options.maximumBytes, options.label);
  return parseMultipartBody(body, boundary, options);
}

function parseMultipartBody(
  body: Uint8Array<ArrayBuffer>,
  boundary: Uint8Array,
  options: {
    label: string;
    fields: Readonly<Record<string, MultipartFieldLimit>>;
  },
): Map<string, Blob | string> {
  const delimiter = concatBytes(new Uint8Array([45, 45]), boundary);
  if (!bytesEqualAt(body, delimiter, 0)) {
    throw invalidMultipart(options.label);
  }

  const result = new Map<string, Blob | string>();
  let cursor = delimiter.byteLength;
  while (true) {
    if (bytesEqualAt(body, new Uint8Array([45, 45]), cursor)) {
      cursor += 2;
      if (bytesEqualAt(body, CRLF, cursor)) {
        cursor += CRLF.byteLength;
      }
      if (cursor !== body.byteLength) {
        throw invalidMultipart(options.label);
      }
      return result;
    }
    if (!bytesEqualAt(body, CRLF, cursor)) {
      throw invalidMultipart(options.label);
    }
    cursor += CRLF.byteLength;

    const headerEnd = indexOfBytes(
      body,
      DOUBLE_CRLF,
      cursor,
      Math.min(body.byteLength, cursor + MAX_PART_HEADER_BYTES + DOUBLE_CRLF.byteLength),
    );
    if (headerEnd === -1 || headerEnd - cursor > MAX_PART_HEADER_BYTES) {
      throw invalidMultipart(options.label);
    }
    const part = parsePartHeaders(body.subarray(cursor, headerEnd), options.label);
    const limits = options.fields[part.name];
    if (!limits || result.has(part.name)) {
      throw invalidMultipart(options.label);
    }
    if ((limits.kind === 'file') !== part.hasFilename) {
      throw invalidMultipart(options.label);
    }

    const contentStart = headerEnd + DOUBLE_CRLF.byteLength;
    const nextBoundary = findNextBoundary(body, delimiter, contentStart);
    if (nextBoundary === -1) {
      throw invalidMultipart(options.label);
    }
    const contentBytes = nextBoundary - contentStart;
    if (contentBytes > limits.maximumBytes) {
      throw new PayloadTooLargeError(`${options.label} field ${part.name} exceeds the maximum allowed size.`);
    }

    const content = body.subarray(contentStart, nextBoundary);
    if (limits.kind === 'file') {
      result.set(part.name, new Blob([content], { type: part.contentType ?? 'application/octet-stream' }));
    } else {
      try {
        result.set(part.name, new TextDecoder('utf-8', { fatal: true }).decode(content));
      } catch {
        throw invalidMultipart(options.label);
      }
    }
    cursor = nextBoundary + CRLF.byteLength + delimiter.byteLength;
  }
}

function multipartBoundary(contentType: string | null, label: string): Uint8Array {
  if (!contentType || !/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    throw invalidMultipart(label);
  }
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const value = match?.[1] ?? match?.[2];
  if (!value || value.length > MAX_BOUNDARY_BYTES) {
    throw invalidMultipart(label);
  }
  const boundary = new TextEncoder().encode(value);
  if (boundary.byteLength !== value.length || boundary.some((byte) => byte < 33 || byte > 126)) {
    throw invalidMultipart(label);
  }
  return boundary;
}

type MultipartPartHeaders = {
  name: string;
  hasFilename: boolean;
  contentType: string | null;
};

function parsePartHeaders(bytes: Uint8Array, label: string): MultipartPartHeaders {
  if (bytes.some((byte) => byte > 127 || byte === 0)) {
    throw invalidMultipart(label);
  }
  const headers = new Map<string, string>();
  const text = new TextDecoder().decode(bytes);
  for (const line of text.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw invalidMultipart(label);
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[a-z0-9-]+$/.test(name) || headers.has(name)) {
      throw invalidMultipart(label);
    }
    headers.set(name, value);
  }

  const disposition = headers.get('content-disposition');
  if (!disposition || !/^form-data(?:\s*;|$)/i.test(disposition)) {
    throw invalidMultipart(label);
  }
  const name = quotedDispositionParameter(disposition, 'name');
  if (!name) {
    throw invalidMultipart(label);
  }
  return {
    name,
    hasFilename: quotedDispositionParameter(disposition, 'filename') !== null,
    contentType: headers.get('content-type') ?? null,
  };
}

function quotedDispositionParameter(disposition: string, parameter: string): string | null {
  const expression = new RegExp(`(?:^|;)\\s*${parameter}="([^"]*)"`, 'i');
  return expression.exec(disposition)?.[1] ?? null;
}

function findNextBoundary(body: Uint8Array, delimiter: Uint8Array, start: number): number {
  const marker = concatBytes(CRLF, delimiter);
  let candidate = start;
  while (candidate < body.byteLength) {
    candidate = indexOfBytes(body, marker, candidate, body.byteLength);
    if (candidate === -1) {
      return -1;
    }
    const suffix = candidate + marker.byteLength;
    if (bytesEqualAt(body, CRLF, suffix) || bytesEqualAt(body, new Uint8Array([45, 45]), suffix)) {
      return candidate;
    }
    candidate++;
  }
  return -1;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start: number, end: number): number {
  const lastStart = Math.min(end, haystack.byteLength) - needle.byteLength;
  for (let index = start; index <= lastStart; index++) {
    if (bytesEqualAt(haystack, needle, index)) {
      return index;
    }
  }
  return -1;
}

function bytesEqualAt(haystack: Uint8Array, needle: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + needle.byteLength > haystack.byteLength) {
    return false;
  }
  for (let index = 0; index < needle.byteLength; index++) {
    if (haystack[offset + index] !== needle[index]) {
      return false;
    }
  }
  return true;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function invalidMultipart(label: string): InvalidMultipartBodyError {
  return new InvalidMultipartBodyError(`${label} must contain only the expected multipart fields.`);
}
