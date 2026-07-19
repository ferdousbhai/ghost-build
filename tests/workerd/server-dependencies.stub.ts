const unavailable = () => new Response('Unavailable in the workerd route integration suite', { status: 503 });

export default { fetch: unavailable };

export class BuilderAgent {}
export class ContainerProxy {}
export class DeploymentSandbox {}
export class DeploymentWorkflow {}

export const CLOUDFLARE_CONNECTION_CALLBACK_METHOD = 'GET' as const;
export const authSessionAction = unavailable;
export const clientTelemetryAction = unavailable;
export const cloudflareConnectionStatusAction = unavailable;
export const completeCloudflareConnectionAction = unavailable;
export const createDeploymentPlanAction = unavailable;
export const dataAction = unavailable;
export const deploymentAction = unavailable;
export const drainDeferredDataGcBestEffort = async () => {};
export const enhancePromptAction = unavailable;
export const feedbackAction = unavailable;
export const initialMessagesAction = unavailable;
export const pruneCloudflareAuthDataBestEffort = async () => {};
export const routeAuthorizedAgentRequest = async () => null;
export const scriptsAction = unavailable;
export const signOutAction = unavailable;
export const storageObjectAction = unavailable;
export const storeChatAction = unavailable;
export const uploadThumbnailAction = unavailable;
