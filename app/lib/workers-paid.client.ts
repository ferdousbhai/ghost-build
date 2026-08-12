import { toast } from 'sonner';

export const WORKERS_PAID_URL = 'https://dash.cloudflare.com/?to=/:account/workers/plans';
const AI_GATEWAY_URL = 'https://dash.cloudflare.com/?to=/:account/ai/ai-gateway';
const DEEPSEEK_CREDIT_RECOMMENDATION_TOAST_ID = 'deepseek-ai-gateway-credit-recommendation';

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
    'This third-party model uses AI Gateway Unified Billing, but your Cloudflare account has no credits available. In AI Gateway, select Credits Available, Manage, then Top-up credits to continue. Ghostbuild did not make a purchase.',
    {
      action: {
        label: 'Open AI Gateway',
        onClick: () => window.open(AI_GATEWAY_URL, '_blank', 'noopener'),
      },
    },
  );
}

export function showDeepSeekCreditRecommendationToast(): void {
  toast.info(
    'DeepSeek V4 Pro is recommended, but your Cloudflare account has no AI Gateway Unified Billing credits available. A Cloudflare-hosted model is selected for now. In AI Gateway, select Credits Available, Manage, then Top-up credits to use DeepSeek.',
    {
      id: DEEPSEEK_CREDIT_RECOMMENDATION_TOAST_ID,
      action: {
        label: 'Open AI Gateway',
        onClick: () => window.open(AI_GATEWAY_URL, '_blank', 'noopener'),
      },
    },
  );
}
