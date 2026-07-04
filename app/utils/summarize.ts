/**
 * Recursively processes an object and shortens all string fields to 100 characters with ellipses.
 * Useful for logging large objects without overwhelming Sentry.
 */
export function summarize<T>(obj: T, maxLength: number = 100): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return (obj.length <= maxLength ? obj : `${obj.slice(0, maxLength)}...`) as T;
  }

  if (typeof obj === 'object') {
    if (Array.isArray(obj)) {
      return obj.map((item) => summarize(item, maxLength)) as T;
    }

    return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, summarize(value, maxLength)])) as T;
  }

  return obj;
}
