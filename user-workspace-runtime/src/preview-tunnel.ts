type PreviewTunnel = {
  url: string;
};

type PreviewTunnels = {
  get(port: number): Promise<PreviewTunnel>;
};

export function openPreviewQuickTunnel(tunnels: PreviewTunnels, port: number): Promise<PreviewTunnel> {
  return tunnels.get(port);
}
