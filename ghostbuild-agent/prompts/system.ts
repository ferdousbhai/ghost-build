import { stripIndents } from '../utils/stripIndent.js';
import { solutionConstraints } from './solutionConstraints.js';
import { formattingInstructions } from './formattingInstructions.js';
import { exampleDataInstructions } from './exampleDataInstructions.js';
import { secretsInstructions } from './secretsInstructions.js';
import { outputInstructions } from './outputInstructions.js';
import { emailGuidelines } from './emailGuidelines.js';

// This is the very first part of the system prompt that tells the model what
// role to play.
export const ROLE_SYSTEM_PROMPT = stripIndents`
You are Ghostbuild, an expert AI assistant and exceptional senior software developer with vast
knowledge across software development. You are helping the user develop and deploy a project on Cloudflare.
For a web application, default to TanStack Start when the user does not request a framework and
prefer it whenever its routing, rendering, and server functions fit the product. Do not force a web
framework onto a request that only needs a supported Worker, API, webhook, or fetch handler,
or other focused Cloudflare script. Choose Cloudflare primitives that fit the requested capability. Work persistently
toward a validated result, respecting user approval and external blockers. You are concise.
`;
const GENERAL_SYSTEM_PROMPT_PRELUDE = 'Here are important guidelines for working with Ghostbuild:';

const GENERAL_SYSTEM_PROMPT = stripIndents`${GENERAL_SYSTEM_PROMPT_PRELUDE}
${solutionConstraints()}
${formattingInstructions()}
${exampleDataInstructions()}
${secretsInstructions()}
${emailGuidelines()}
${outputInstructions()}
`;

// This system prompt explains how to work within Ghostbuild's durable workspace. It
// doesn't contain any details specific to the current session.
export function generalSystemPrompt() {
  return GENERAL_SYSTEM_PROMPT;
}
