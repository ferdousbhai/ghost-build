export const DEPLOYMENT_COMPATIBILITY_DATE = '2026-07-18';
export const DEPLOYMENT_COMPATIBILITY_FLAGS = ['nodejs_compat'] as const;
export const DEPLOYMENT_OBSERVABILITY = {
  enabled: true,
  logs: { enabled: true, head_sampling_rate: 0.6 },
  traces: { enabled: true, head_sampling_rate: 0.05 },
} as const;
export const APP_AGENT_DECLARATIVE_EXPORT = {
  type: 'durable-object',
  storage: 'sqlite',
} as const;
