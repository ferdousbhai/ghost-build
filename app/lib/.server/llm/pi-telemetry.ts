export function recordPiStage(stage: string, modelId: string, status?: number): void {
  console.info({ event: 'ghostbuild_pi_stage', stage, modelId, ...(status === undefined ? {} : { status }) });
}
