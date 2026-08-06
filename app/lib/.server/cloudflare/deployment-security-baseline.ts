import { BUILDER_TEMPLATE_SOURCE_SHA256 } from '~/agents/builder-template.generated';

export const DEPLOYMENT_SECURITY_BASELINE_VERSION = 29 as const;
export {
  DEPLOYMENT_SECURITY_BASELINE_BINDING,
  DEPLOYMENT_SECURITY_BOUNDARY_BINDING,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
  DEPLOYMENT_TEMPLATE_SOURCE_BINDING,
  DEPLOYMENT_VERSION_METADATA_BINDING,
} from './deployment-runtime-policy';

export const TEMPLATE_SOURCE_SHA256 = BUILDER_TEMPLATE_SOURCE_SHA256;

/**
 * These files form the generated AppAgent's authentication, inference-budget,
 * retention, and request-routing boundary. Exact digests deliberately make
 * automatic deployment fail closed when generated code changes that boundary.
 * A changed boundary must ship as a reviewed baseline before it can be
 * attested by the managed publisher.
 */
export const APP_AGENT_PROTECTED_FILE_SHA256 = {
  'agent-security-migrations/0001_agent_security.sql':
    'cc62c34bcfb5e176155e371a099d000679ae69877facf252fe3d3c7e1190fbeb',
  'eslint.config.js': 'a440b7f8bc1fb58656d21817e53dfde75fbbaf3afe6b59e9ef7d2f7ad699155d',
  'migrations/0001_app_data.sql': '114d3df6142196cb43a95e5896e1b9a8e8753514becf3400884b27acb5793d65',
  'postcss.config.cjs': 'fa650b380adfabb151a0b352f7135e107e6352345f899060f1c5c231228f94bf',
  'scripts/cf-typegen.mjs': '6c82a0afdb50c32b205dbe4677b207337a38ad7ea70950a3e63758f0c04e1ae7',
  'scripts/lib/production-license-artifact.mjs': 'e9ff7fc97973e4299f9a4b3026f148f3e32e6c2ff71d21bdbc40ae1e60d49892',
  'scripts/lib/runtime-module-security.ts': 'b3bfa3863b861a3d2a6fc068e29c8bbde7c240634058bd3537a124c876dbf8f9',
  'scripts/lib/project-policy.mjs': '5a2e78715a0daf68a7b3781211b0b0deaec04e61bf3e36b98597b9f0b885b32b',
  'scripts/lib/project-policy/dependency-policy.mjs':
    'd236505967fc5d1bba39d9ac1bc436fa251c5d49e5d420c5ce04b6b1ecfbce03',
  'scripts/lib/project-policy/generated-project-dependency-policy.json':
    'd8932f5a64af4b91dddb9b17c1be13cefc48d546cd5042193d2b9bdc6ff85c8b',
  'scripts/lib/project-policy/source-policy.mjs': 'deed7d40e7c9c1bca8cfb3dbf46503f9dc89a4004988f8ef55871b7ed0c24f86',
  'scripts/lib/project-policy/worker-policy.mjs': '9f908807030d1a91c99b442b41488048d2e49b996783a18900b413e046f3edbc',
  'scripts/lib/project-policy/workflow-policy.mjs': 'e4c172b80ffe2f551a4ca25d4f8a4d0ea19195a7cef0ee056536e331d3993fab',
  'scripts/lib/project-policy/workspace-policy.mjs': '765e1bab8bad64631645513f2f5ac2f66c83fdb52d9bcf60f99e518b06d7ec46',
  'scripts/provision-cloudflare-production.mjs': '5e55ec67b6aec6395b01119b8b18ff76d3c37cc03c448153647e8d2348edebbf',
  'scripts/verify-production-config.mjs': 'f4c28d005c92d4a68e1101157b75cd95f8e4bc0d2d5379a69275e79680c3c8e5',
  'scripts/verify-production-licenses.mjs': '22952be32b45c416551ca2681a202b72c616aca61c6643ce946868373320a82d',
  'scripts/verify-stack-alignment.mjs': 'e95b0ee0291186b45143e8d9e96ad2a2089b8d08e5aed61a75e25eb9ef002388',
  'src/agent-routing.ts': '0000bd8d4daa8b0b84d5e176c955b8ee0983e013b87079fa47414b79f7963b57',
  'src/agent-security.ts': '72f32a6bc2dd1b8d36c4f1c57dce2c00ed29ae30662e1f26b1d8011cdc8c8124',
  'src/agents/anonymous-retention.ts': '38489c93827bc38bcf48deac80005fbe03c6bbb31a6c4fe885c6064e22eb05ae',
  'src/agents/app-agent.ts': '38db7b77ad8420ec8d39cc2144f2510d5c5493a9e7c047bbee354a122ef0b2d3',
  'src/agents/chat-policy.ts': '16a806aa0e26b5c7057e70fecb59cbbfd08921e36e8d2b967102eab6b7e6dec2',
  'src/app-bindings.ts': '6f5fd82619b6bd55d20ee66428ad264aaf8dfee7b179efeb7cf3eb09906a7998',
  'src/application-response.ts': '70f3c2a456f3bd7ae96385d78ec06c4555e5b7d0bf2845594e5f5ba9949d5fec',
  'src/preview-server.ts': '951ab600e7dee5704506a4d2c3a640e2bcd1356b41a2b31519dea973741cc27e',
  'src/server.ts': '464dc8fc95be9e8f9a843a4aed82e9152afd0080b11ec6293855247f282a6c78',
  'src/workers-ai.shared.ts': '04a50a0d46bcb5a24dfe0a0d1d597112eed890e38ff11f384ebbdfba7ab26f0e',
  'tailwind.config.js': 'c43ce7f83ee3ef0259121fa47ebc98dcb67a25a106aea5318fb0559ce72bc558',
  'tsconfig.json': 'c14eb952e03148b89b4ff6b8f2a60762f5465b7fd7361a32e7c987eb22a320e6',
  'vite.config.ts': 'a19e677583fb7af45068519f5451aa7993b0dcbfff429f39b2945e5158b00541',
  'wrangler.preview.jsonc': 'b7e17326710f92a9d1bf3b828612ddf7823af0b87a0c86bedfd0077f362587bb',
} as const;

export const APP_AGENT_SECURITY_BOUNDARY_SHA256 = 'fcdcd2a071b697d8ed16862988dce607fd58ec2ed7ab326ff5f0848145cddf61';

export const APP_AGENT_PROTECTED_LOCK_ENTRIES_SHA256 =
  '16462d8b164f2cb4bed01d6fa3ae297962407b620fed6e88d5dad6eeaf32b46b';

export function isCurrentDeploymentSecurityIdentity(value: {
  version?: unknown;
  templateSourceSha256?: unknown;
  securityBaselineVersion?: unknown;
  securityBoundarySha256?: unknown;
}): boolean {
  return (
    value.version === 2 &&
    value.templateSourceSha256 === TEMPLATE_SOURCE_SHA256 &&
    value.securityBaselineVersion === DEPLOYMENT_SECURITY_BASELINE_VERSION &&
    value.securityBoundarySha256 === APP_AGENT_SECURITY_BOUNDARY_SHA256
  );
}
