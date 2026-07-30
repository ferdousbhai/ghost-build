import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import {
  activateCloudflareSkillUpdates,
  inspectCloudflareSkillUpdates,
  recordSkillSyncFailure,
  recordUnchangedSkillSync,
} from '~/lib/.server/skills/skill-sync';

const RETRIES = {
  retries: { limit: 3, delay: '30 seconds' as const, backoff: 'exponential' as const },
  timeout: '10 minutes' as const,
} satisfies WorkflowStepConfig;

export class SkillSyncWorkflow extends WorkflowEntrypoint<Env> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    try {
      const inspection = await step.do('inspect upstream skill metadata', RETRIES, () =>
        inspectCloudflareSkillUpdates(this.env),
      );
      if (inspection.status === 'unchanged') {
        await step.do('record unchanged skill catalog', RETRIES, () =>
          recordUnchangedSkillSync(this.env, inspection.treeSha),
        );
        return { status: 'unchanged', treeSha: inspection.treeSha };
      }
      const result = await step.do('store and activate changed skills', RETRIES, () =>
        activateCloudflareSkillUpdates(this.env, inspection),
      );
      return {
        status: result.changed === 0 ? 'no-relevant-changes' : 'updated',
        treeSha: inspection.treeSha,
        ...result,
      };
    } catch (error) {
      await step.do(
        'record skill synchronization failure',
        { retries: { limit: 1, delay: '10 seconds' }, timeout: '1 minute' },
        () => recordSkillSyncFailure(this.env, error),
      );
      throw error;
    }
  }
}
