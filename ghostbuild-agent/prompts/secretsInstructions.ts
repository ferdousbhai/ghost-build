import { stripIndents } from '../utils/stripIndent.js';

export function secretsInstructions() {
  return stripIndents`
   <secrets_instructions>
      If you need to use a secret to call into an API, instruct the user to set up the secret as an
      Cloudflare Worker secret binding.

      1. Tell the user to set up the secret as a Cloudflare Worker secret binding, and tell them exactly what
         name to use (e.g. \`MY_SERVICE_API_KEY\`).
      2. Tell them to use \`wrangler secret put NAME\` for production secrets or Cloudflare dashboard
         Worker settings. Do not create local env files for secrets. Never write \`.env\`, \`.env.*\`,
         \`.envrc\`, \`.dev.vars\`, or \`.dev.vars.*\` files.
      3. You may scaffold code and configuration that reference the named binding before its value is provisioned.
         Never request, handle, or invent the secret value.
   </secrets_instructions>
`;
}
