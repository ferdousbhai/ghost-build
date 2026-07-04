#!/usr/bin/env node

import { writeFileSync } from 'fs';
import { ROLE_SYSTEM_PROMPT, generalSystemPrompt } from './ghostbuild-agent/prompts/system.js';

console.log('Building ghostbuild system prompts release...');

let output: string = `# Ghostbuild System Prompts\n`;
output += `Generated on: ${new Date().toISOString()}\n`;
output += `========================================\n\n`;
output += `This file contains the system prompts sent to Ghostbuild.\n\n`;

output += `## System Message 1: ROLE_SYSTEM_PROMPT\n\n`;
output += ROLE_SYSTEM_PROMPT + '\n\n';
output += `---\n\n`;

output += `## System Message 2: General System Prompt\n\n`;
try {
  const generalPromptContent = generalSystemPrompt();
  output += generalPromptContent + '\n\n';
  output += `---\n\n`;
} catch (error: unknown) {
  const errorMessage: string = error instanceof Error ? error.message : String(error);
  console.log(`Could not generate general system prompt: ${errorMessage}`);
}

writeFileSync('ghostbuild-system-prompts.txt', output);
console.log('✅ Built ghostbuild-system-prompts.txt');
