export const WORKERS_PAID_REQUIRED_MARKER = 'GHOSTBUILD_WORKERS_PAID_REQUIRED:';
export const CLOUDFLARE_AI_FUNDING_REQUIRED_MARKER = 'GHOSTBUILD_CLOUDFLARE_AI_FUNDING_REQUIRED:';

export function workersPaidRequiredMessage(): string {
  return `${WORKERS_PAID_REQUIRED_MARKER} Your connected Cloudflare account exhausted its free Workers AI allocation. Review and explicitly authorize Workers Paid in Cloudflare to continue; Ghostbuild did not upgrade your plan.`;
}

export function isWorkersAiFreeAllocationError(error: unknown): boolean {
  return /(free\s+(?:ai\s+)?allocation|neuron(?:s)?\s+(?:limit|quota)|daily\s+(?:ai\s+)?limit|upgrade\s+to\s+workers\s+paid|workers\s+paid\s+(?:plan\s+)?required)/i.test(
    providerErrorDetails(error),
  );
}

export function cloudflareAiFundingRequiredMessage(): string {
  return `${CLOUDFLARE_AI_FUNDING_REQUIRED_MARKER} This Cloudflare partner model requires AI Gateway balance or BYOK. Review billing in Cloudflare to continue; Ghostbuild did not make a purchase.`;
}

export function isCloudflareAiFundingError(error: unknown): boolean {
  return /insufficient\s+balance|add\s+money\s+to\s+your\s+gateway|use\s+BYOK/i.test(providerErrorDetails(error));
}

function providerErrorDetails(error: unknown): string {
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
  return [
    error instanceof Error ? error.message : String(error),
    typeof record?.responseBody === 'string' ? record.responseBody : '',
    typeof record?.data === 'string' ? record.data : '',
  ].join(' ');
}
