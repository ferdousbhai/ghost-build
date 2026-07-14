export const WORKERS_PAID_REQUIRED_MARKER = 'GHOSTBUILD_WORKERS_PAID_REQUIRED:';

export function workersPaidRequiredMessage(): string {
  return `${WORKERS_PAID_REQUIRED_MARKER} Your connected Cloudflare account exhausted its free Workers AI allocation. Review and explicitly authorize Workers Paid in Cloudflare to continue; Ghostbuild did not upgrade your plan.`;
}

export function isWorkersAiFreeAllocationError(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  const details = [
    error instanceof Error ? error.message : String(error),
    typeof record?.responseBody === 'string' ? record.responseBody : '',
    typeof record?.data === 'string' ? record.data : '',
  ].join(' ');
  return /(free\s+(?:ai\s+)?allocation|neuron(?:s)?\s+(?:limit|quota)|daily\s+(?:ai\s+)?limit|upgrade\s+to\s+workers\s+paid|workers\s+paid\s+(?:plan\s+)?required)/i.test(
    details,
  );
}
