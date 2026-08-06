export function previewQuickTunnelUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const quickTunnel = url.hostname !== 'trycloudflare.com' && url.hostname.endsWith('.trycloudflare.com');
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && quickTunnel ? url.href : null;
  } catch {
    return null;
  }
}
