export const CLIENT_TELEMETRY_EVENTS = [
  'Builder client tool call failed',
  'Builder connection was not ready before send',
  'Failed to deliver Builder tool output for continuation',
  'Failed to enhance prompt',
  'Failed to fetch dashboard version information',
  'Failed to process chat request',
  'Failed to share project thumbnail',
  'Failed to start Cloudflare authorization',
  'Failed to submit chat message',
  'Preview base URL unexpectedly had a trailing slash',
  'Preview key event arrived before base URL',
  'Preview key event arrived before iframe URL',
  'Unknown assistant message part',
  'User tried to send message but Ghostbuild is too busy',
] as const;

export type ClientTelemetryEvent = (typeof CLIENT_TELEMETRY_EVENTS)[number];
