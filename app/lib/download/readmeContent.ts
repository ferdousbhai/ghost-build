export function generateReadmeContent(description: string) {
  return `# ${description}

This Cloudflare Workers project was built with Ghostbuild.

\`\`\`sh
pnpm run dev
pnpm run preview
pnpm run validate
\`\`\`

## Deployment

\`\`\`sh
pnpm run deploy
\`\`\`

After changing production dependencies, refresh the checked-in license notices before validation or deployment:

\`\`\`sh
pnpm run licenses:generate
\`\`\`

Keep secret values out of source and local environment files. Configure them with Wrangler or in the Cloudflare dashboard.
`;
}
