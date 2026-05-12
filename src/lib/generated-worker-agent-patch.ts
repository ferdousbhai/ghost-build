import { createOpenAI } from '@ai-sdk/openai'
import { generateObject } from 'ai'
import { z } from 'zod'
import type { BuildCheckResult } from './build-checks'
import {
  applyGeneratedWorkerPatches,
  type GeneratedWorkerPatch,
  type GeneratedWorkerPatchResult,
} from './generated-worker-patch'
import type { GeneratedWorkerApp } from './generated-worker-app'

const generatedWorkerPatchSchema = z.object({
  patches: z.array(
    z.discriminatedUnion('operation', [
      z.object({
        operation: z.literal('upsert'),
        path: z.string().min(1),
        content: z.string(),
      }),
      z.object({
        operation: z.literal('delete'),
        path: z.string().min(1),
      }),
    ]),
  ),
})

export type AgentPatchProposal = z.infer<typeof generatedWorkerPatchSchema>

export type AgentPatchProposer = (input: {
  checkResult: BuildCheckResult
  generatedApp: GeneratedWorkerApp
  goal: string
}) => Promise<AgentPatchProposal>

export type AgentPatchResult = GeneratedWorkerPatchResult & {
  proposedPatches: Array<GeneratedWorkerPatch>
}

export async function proposeAndApplyGeneratedWorkerPatches({
  checkResult,
  generatedApp,
  goal,
  openAiApiKey,
  proposer,
}: {
  checkResult: BuildCheckResult
  generatedApp: GeneratedWorkerApp
  goal: string
  openAiApiKey?: string
  proposer?: AgentPatchProposer
}): Promise<AgentPatchResult> {
  if (checkResult.status !== 'failed') {
    return {
      ...applyGeneratedWorkerPatches(generatedApp, []),
      proposedPatches: [],
    }
  }

  const proposal = proposer
    ? await proposer({ checkResult, generatedApp, goal })
    : await proposeGeneratedWorkerPatchesWithModel({
        checkResult,
        generatedApp,
        goal,
        openAiApiKey,
      })
  const patchResult = applyGeneratedWorkerPatches(
    generatedApp,
    proposal.patches,
  )

  return {
    ...patchResult,
    proposedPatches: proposal.patches,
  }
}

async function proposeGeneratedWorkerPatchesWithModel({
  checkResult,
  generatedApp,
  goal,
  openAiApiKey,
}: {
  checkResult: BuildCheckResult
  generatedApp: GeneratedWorkerApp
  goal: string
  openAiApiKey?: string
}) {
  if (!openAiApiKey) {
    throw new Error('Server-side OpenAI API key is required to propose patches.')
  }

  const { object } = await generateObject({
    model: createOpenAI({ apiKey: openAiApiKey })('gpt-5.5'),
    schema: generatedWorkerPatchSchema,
    system: [
      'You are GhostBuild, a Cloudflare-native web app patch agent.',
      'Return only structured patches for generated Worker app files.',
      'Keep patch paths relative to the generated app root.',
      'Prefer small upserts that fix failed checks without deleting required files.',
    ].join('\n'),
    prompt: [
      `Goal: ${goal}`,
      `Worker: ${generatedApp.workerName}`,
      '',
      'Failed checks:',
      ...checkResult.checks
        .filter((check) => check.status === 'failed')
        .map((check) => `- ${check.name}: ${check.detail}`),
      '',
      'Current files:',
      ...generatedApp.files.map(
        (file) => `--- ${file.path}\n${file.content.slice(0, 6000)}`,
      ),
    ].join('\n'),
  })

  return object
}
