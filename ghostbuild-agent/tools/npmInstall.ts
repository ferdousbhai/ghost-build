import type { Tool } from 'ai';
import { z } from 'zod';
import { isForbiddenStackDependencyPackageName, packageNameFromInstallSpec } from '../utils/stackPolicy.js';

export { packageNameFromInstallSpec } from '../utils/stackPolicy.js';

const npmInstallToolDescription = `
Install additional dependencies for the project with pnpm.

Choose high quality, flexible libraries that are well-maintained and have
significant adoption. Always use libraries that have TypeScript definitions.
Keep runtime, data, and AI dependencies inside the TanStack + Cloudflare stack:
do not install Convex, Remix, OpenAI, Anthropic, Gemini, xAI, Groq, Mistral,
or other non-Workers-AI provider SDKs.
`;

const packagesDescription = `
Space separated list of packages to install. This will be passed directly to \`pnpm add\`.

Examples:
- 'date-fns'
- 'chart.js react-chartjs-2'
- 'motion'
`;

export function splitPackageSpecs(packages: string) {
  return packages.trim().split(/\s+/).filter(Boolean);
}

export function findForbiddenNpmInstallPackages(packages: string) {
  return splitPackageSpecs(packages)
    .map((spec) => ({ spec, packageName: packageNameFromInstallSpec(spec) }))
    .filter(({ packageName }) => isForbiddenStackDependencyPackageName(packageName));
}

function findInvalidNpmInstallSpecs(packages: string) {
  return splitPackageSpecs(packages).filter((spec) => spec.startsWith('-'));
}

export const npmInstallToolParameters = z.object({
  packages: z
    .string()
    .trim()
    .min(1)
    .superRefine((packages, ctx) => {
      const invalidSpecs = findInvalidNpmInstallSpecs(packages);
      if (invalidSpecs.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pnpm flags are not allowed in npmInstall packages: ${invalidSpecs.join(', ')}`,
        });
      }

      const forbiddenPackages = findForbiddenNpmInstallPackages(packages);
      if (forbiddenPackages.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsupported package(s): ${forbiddenPackages
            .map(({ spec }) => spec)
            .join(', ')}. Use Cloudflare Workers AI and TanStack/Cloudflare APIs instead.`,
        });
      }
    })
    .describe(packagesDescription),
});

export const npmInstallTool: Tool = {
  description: npmInstallToolDescription,
  inputSchema: npmInstallToolParameters,
};
