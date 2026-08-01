import type { BuilderAgent } from './agents/builder-agent';

declare global {
  /** Bindings that exist only inside the generated, user-owned runtime bundle. */
  interface Env {
    APP_STORAGE: R2Bucket;
    BuilderAgent: DurableObjectNamespace<BuilderAgent>;
  }
}

export {};
