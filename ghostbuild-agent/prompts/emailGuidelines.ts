import { stripIndents } from '../utils/stripIndent.js';

export function emailGuidelines() {
  return stripIndents`
  <email_guidelines>
    If an app needs email, keep email handling in Cloudflare Worker code and avoid bundling a default
    third-party provider SDK. Ask the user which production email service they want to bind before
    adding provider-specific code.

    Ask the user to configure any provider token as a Cloudflare Worker secret binding with
    \`wrangler secret put NAME\` or Cloudflare dashboard Worker settings. Do not write local env files
    and do not use app-builder email proxy variables in generated apps.
  </email_guidelines>
  `;
}
