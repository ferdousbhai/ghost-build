import type { Tool } from 'ghostbuild-agent/pi-tool-compat';
import { z } from 'zod';
import {
  isForbiddenStackDependencyPackageName,
  isRegistryPackageSpec,
  packageNameFromInstallSpec,
} from '../utils/stackPolicy.js';

const npmInstallToolDescription = `
Install additional dependencies or synchronize the lockfile for the project with pnpm.

Choose high quality, flexible libraries that are well-maintained and have
significant adoption. Always use libraries that have TypeScript definitions.
After directly editing dependency fields in package.json, use mode \`sync-lockfile\`
so pnpm-lock.yaml remains consistent. Do not pass package names in that mode.
Keep runtime, data, and AI dependencies inside the Cloudflare platform stack. TanStack Start is the
default for full web applications, but focused Worker scripts do not need an application framework:
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

export const npmInstallToolParameters = z
  .object({
    mode: z.enum(['add', 'sync-lockfile']).optional(),
    packages: z.string().trim().max(2_000).optional().describe(packagesDescription),
  })
  .superRefine((input, ctx) => {
    const mode = input.mode ?? 'add';
    if (mode === 'sync-lockfile') {
      if (input.packages) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['packages'],
          message: 'Package names are not allowed when synchronizing the lockfile.',
        });
      }
      return;
    }
    if (!input.packages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packages'],
        message: 'At least one package is required in add mode.',
      });
      return;
    }
    const packages = input.packages;
    if (splitPackageSpecs(packages).length > 50) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packages'],
        message: 'Install at most 50 packages in one npmInstall call.',
      });
    }
    const invalidSpecs = findInvalidNpmInstallSpecs(packages);
    if (invalidSpecs.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `pnpm flags are not allowed in npmInstall packages: ${invalidSpecs.join(', ')}`,
      });
    }
    const nonRegistrySpecs = splitPackageSpecs(packages).filter((spec) => !isRegistryPackageSpec(spec));
    if (nonRegistrySpecs.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packages'],
        message: `Only npm registry package names and versions are allowed: ${nonRegistrySpecs.join(', ')}.`,
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
  });

export const npmInstallTool: Tool = {
  description: npmInstallToolDescription,
  inputSchema: npmInstallToolParameters,
};
