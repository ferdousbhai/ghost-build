export type DeploymentProjectType = 'web_app' | 'worker';

export type DeploymentProjectProfile = {
  type: DeploymentProjectType;
  bindings: {
    ai: boolean;
    d1: boolean;
    r2: boolean;
    appAgent: boolean;
  };
};
