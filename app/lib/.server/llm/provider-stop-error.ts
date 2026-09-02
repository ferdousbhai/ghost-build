import { getOverflowPatterns } from '@earendil-works/pi-ai';

/**
 * A provider that ends a turn without an answer reaches the operator log as a class and nothing
 * else: `logProviderFailure` records `kind` and `diagnosticCode`, never the message. The message
 * still has to travel, because the chat shows it to the account owner in their own project, so it
 * stays on the error and the classification rides alongside it.
 */
export class ProviderStopError extends Error {
  readonly diagnosticCode: string;

  constructor(message: string, diagnosticCode: string) {
    super(message);
    this.name = 'ProviderStopError';
    this.diagnosticCode = diagnosticCode;
  }
}

/** Pi's wording for a stream that stopped before the provider declared a finish reason. */
const STREAM_WITHOUT_FINISH_PATTERN = /without finish_reason/i;

/** `mapStopReason` in Pi's OpenAI Completions adapter emits `Provider finish_reason: <reason>`. */
const PROVIDER_FINISH_PATTERN = /Provider finish_reason: (\w{1,32})/;

/**
 * The HTTP status however the SDK framed it: the OpenAI client's own `400 status code (no body)`,
 * Pi's `formatProviderError` composing `400: <body>`, and its prefixed `Workers AI (400): <body>`.
 */
const HTTP_STATUS_PATTERN = /^(?:[^(\n]{1,40}\()?([45]\d\d)[\s:)]/;

/**
 * A closed vocabulary, so the failure class is comparable across turns and models. Overflow is
 * decided before the HTTP status because an overflow arrives as a 400 whose actionable cause is the
 * context, not the status line.
 */
export function providerStopDiagnosticCode(message: string): string {
  const text = message.trim();
  if (STREAM_WITHOUT_FINISH_PATTERN.test(text)) {
    return 'stream_ended_without_finish';
  }
  const finishReason = PROVIDER_FINISH_PATTERN.exec(text)?.[1];
  if (finishReason) {
    return `provider_finish_${finishReason.toLowerCase()}`;
  }
  if (getOverflowPatterns().some((pattern) => pattern.test(text))) {
    return 'context_overflow';
  }
  const status = HTTP_STATUS_PATTERN.exec(text)?.[1];
  if (status) {
    return `http_${status}`;
  }
  return 'provider_error_other';
}
