export function previewWorkerUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const workersPreview =
      /^[0-9a-f]{8}-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/.test(
        url.hostname,
      );
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && workersPreview ? url.href : null;
  } catch {
    return null;
  }
}
