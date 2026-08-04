import type { BuilderAgent } from './agents/builder-agent';
import type { ProjectWorkspaceRpc } from './agents/builder-workspace-api';

declare global {
  /** Bindings that exist only inside the generated, user-owned runtime bundle. */
  interface Env {
    BuilderAgent: DurableObjectNamespace<BuilderAgent>;
    PROJECT_WORKSPACE: DurableObjectNamespace<ProjectWorkspaceRpc>;
    GHOSTBUILD_USER_RUNTIME: string;
    GHOSTBUILD_USER_ID: string;
    GHOSTBUILD_CONTROL_PLANE_ENDPOINT: string;
    CONTROL_PLANE_SECRET: string;
    CLOUDFLARE_ACCOUNT_ID: string;
    GHOSTBUILD_CONNECTION_ID: string;
    GHOSTBUILD_CONNECTION_GENERATION: string;
  }
}

export {};
