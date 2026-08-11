import { toast } from 'sonner';

export const WORKERS_PAID_URL = 'https://dash.cloudflare.com/?to=/:account/workers/plans';
const AI_GATEWAY_URL = 'https://dash.cloudflare.com/?to=/:account/ai/ai-gateway';

export function showWorkersPaidRequiredToast(): void {
  toast.warning(
    'Your Cloudflare Workers AI free allocation is exhausted. Ghostbuild did not change your plan; authorize Workers Paid in Cloudflare if you want to continue.',
    {
      action: {
        label: 'Review Workers Paid',
        onClick: () => window.open(WORKERS_PAID_URL, '_blank', 'noopener'),
      },
    },
  );
}

export function showCloudflareAiFundingRequiredToast(): void {
  toast.warning(
    'This partner model requires prepaid Cloudflare AI Gateway credits. Ghostbuild did not make a purchase.',
    {
      action: {
        label: 'Review AI Gateway',
        onClick: () => window.open(AI_GATEWAY_URL, '_blank', 'noopener'),
      },
    },
  );
}
