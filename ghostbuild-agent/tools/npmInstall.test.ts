import { describe, expect, it } from 'vitest';
import {
  findForbiddenNpmInstallPackages,
  npmInstallToolParameters,
  packageNameFromInstallSpec,
  splitPackageSpecs,
} from './npmInstall.js';

describe('npmInstall tool parameters', () => {
  it('accepts ordinary package specs', () => {
    expect(
      npmInstallToolParameters.parse({
        packages: 'date-fns chart.js@^4.0.0 @radix-ui/react-dialog @ai-sdk/provider @ai-sdk/react',
      }),
    ).toEqual({
      packages: 'date-fns chart.js@^4.0.0 @radix-ui/react-dialog @ai-sdk/provider @ai-sdk/react',
    });
  });

  it('normalizes package names from versioned and aliased specs', () => {
    expect(packageNameFromInstallSpec('openai@latest')).toBe('openai');
    expect(packageNameFromInstallSpec('@radix-ui/react-dialog')).toBe('@radix-ui/react-dialog');
    expect(packageNameFromInstallSpec('@ai-sdk/openai@4.0.0')).toBe('@ai-sdk/openai');
    expect(packageNameFromInstallSpec('model-sdk@npm:@anthropic-ai/sdk@latest')).toBe('@anthropic-ai/sdk');
  });

  it('finds forbidden provider and framework packages', () => {
    expect(
      findForbiddenNpmInstallPackages('convex @remix-run/react@latest @ai-sdk/openai model-sdk@npm:@anthropic-ai/sdk'),
    ).toEqual([
      { spec: 'convex', packageName: 'convex' },
      { spec: '@remix-run/react@latest', packageName: '@remix-run/react' },
      { spec: '@ai-sdk/openai', packageName: '@ai-sdk/openai' },
      { spec: 'model-sdk@npm:@anthropic-ai/sdk', packageName: '@anthropic-ai/sdk' },
    ]);
  });

  it('rejects unsupported package installs', () => {
    const parsed = npmInstallToolParameters.safeParse({
      packages: 'lucide-react openai @ai-sdk/groq@latest @ai-sdk/amazon-bedrock @google/genai',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain(
      'Unsupported package(s): openai, @ai-sdk/groq@latest, @ai-sdk/amazon-bedrock, @google/genai',
    );
  });

  it('rejects pnpm flags in package install requests', () => {
    const parsed = npmInstallToolParameters.safeParse({ packages: '-D date-fns' });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe('pnpm flags are not allowed in npmInstall packages: -D');
  });

  it('splits package specs by whitespace', () => {
    expect(splitPackageSpecs('  clsx\nlucide-react\tdate-fns  ')).toEqual(['clsx', 'lucide-react', 'date-fns']);
  });
});
