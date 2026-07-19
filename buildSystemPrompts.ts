#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROLE_SYSTEM_PROMPT, generalSystemPrompt } from './ghostbuild-agent/prompts/system.js';

const DEFAULT_OUTPUT_PATH = 'ghostbuild-system-prompts.txt';

export function renderSystemPromptsRelease(): string {
  const rolePrompt = normalizeNewlines(ROLE_SYSTEM_PROMPT).trimEnd();
  const generalPrompt = normalizeNewlines(generalSystemPrompt()).trimEnd();
  return [
    '# Ghostbuild System Prompts',
    '========================================',
    '',
    'This file contains the system prompts sent to Ghostbuild.',
    '',
    '## System Message 1: ROLE_SYSTEM_PROMPT',
    '',
    rolePrompt,
    '',
    '---',
    '',
    '## System Message 2: General System Prompt',
    '',
    generalPrompt,
    '',
    '---',
    '',
  ].join('\n');
}

export function buildSystemPromptsRelease(outputPath = DEFAULT_OUTPUT_PATH): void {
  writeFileSync(outputPath, renderSystemPromptsRelease(), { encoding: 'utf8' });
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function isEntrypoint(): boolean {
  const entryPath = process.argv[1];
  return Boolean(entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url);
}

if (isEntrypoint()) {
  const outputPath = process.argv[2] ?? DEFAULT_OUTPUT_PATH;
  console.log('Building ghostbuild system prompts release...');
  buildSystemPromptsRelease(outputPath);
  console.log(`Built ${outputPath}`);
}
