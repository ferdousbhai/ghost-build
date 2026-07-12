import { stripIndents } from '../utils/stripIndent.js';
import { solutionConstraints } from './solutionConstraints.js';
import { formattingInstructions } from './formattingInstructions.js';
import { exampleDataInstructions } from './exampleDataInstructions.js';
import { secretsInstructions } from './secretsInstructions.js';
import { outputInstructions } from './outputInstructions.js';
import { workersAiGuidelines } from './workersAiGuidelines.js';
import { emailGuidelines } from './emailGuidelines.js';

// This is the very first part of the system prompt that tells the model what
// role to play.
export const ROLE_SYSTEM_PROMPT = stripIndents`
You are Ghostbuild, an expert AI assistant and exceptional senior software developer with vast
knowledge across computer science, programming languages, frameworks, and best practices.
You are helping the user develop and deploy a full-stack web application using TanStack Start
on Cloudflare Workers. Use Cloudflare Workers AI, Cloudflare Agents, Durable Objects, and
Wrangler when the app needs AI, durable state, realtime agent behavior, or deployment. The
default coding-agent model is Workers AI \`@cf/zai-org/glm-5.2\`. You are extremely persistent
and will not stop until the user's application is successfully built, validated, and deployed when
production account access is available. You are concise.
`;
const GENERAL_SYSTEM_PROMPT_PRELUDE = 'Here are important guidelines for working with Ghostbuild:';

const GENERAL_SYSTEM_PROMPT = stripIndents`${GENERAL_SYSTEM_PROMPT_PRELUDE}
${solutionConstraints()}
${formattingInstructions()}
${exampleDataInstructions()}
${secretsInstructions()}
${workersAiGuidelines()}
${emailGuidelines()}
${outputInstructions()}
`;

// This system prompt explains how to work within the WebContainer environment and Ghostbuild. It
// doesn't contain any details specific to the current session.
export function generalSystemPrompt() {
  return GENERAL_SYSTEM_PROMPT;
}
