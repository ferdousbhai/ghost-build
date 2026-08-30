import { BUILDER_TEMPLATE_SOURCE_SHA256 } from '~/agents/builder-template.generated';

export const DEPLOYMENT_SECURITY_BASELINE_VERSION = 38 as const;
export {
  DEPLOYMENT_SECURITY_BASELINE_BINDING,
  DEPLOYMENT_SECURITY_BOUNDARY_BINDING,
  DEPLOYMENT_SECURITY_CLEANUP_CRON,
  DEPLOYMENT_PREVIEW_URLS_ENABLED,
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
  'agent-capability.json': '2582edfeb88e8dd055b9a60f0da442c722684d1f067b24d575cbf043401ca2cc',
  'agent-security-migrations/0001_agent_security.sql':
    'cc62c34bcfb5e176155e371a099d000679ae69877facf252fe3d3c7e1190fbeb',
  'eslint.config.js': 'a440b7f8bc1fb58656d21817e53dfde75fbbaf3afe6b59e9ef7d2f7ad699155d',
  'migrations/0001_app_data.sql': '114d3df6142196cb43a95e5896e1b9a8e8753514becf3400884b27acb5793d65',
  'postcss.config.cjs': 'fa650b380adfabb151a0b352f7135e107e6352345f899060f1c5c231228f94bf',
  'scripts/apply-d1-migrations.mjs': '45992aab4353ccbfe78b4f5d9f8ca5dc74933336eed875992c5533af2b0fafcc',
  'scripts/cf-typegen.mjs': '0d1ad225b87cb2c76b323dc9dd46123637996ad49d9f8567943d72fd84dd6360',
  'scripts/enable-agent-capability.mjs': '70cc3cb5fc08417f0e7824d848a4451be5a764d315b4728625820cbc6a8765a6',
  'scripts/lib/production-license-artifact.mjs': 'e9ff7fc97973e4299f9a4b3026f148f3e32e6c2ff71d21bdbc40ae1e60d49892',
  'scripts/lib/runtime-module-security.ts': 'b3bfa3863b861a3d2a6fc068e29c8bbde7c240634058bd3537a124c876dbf8f9',
  'scripts/lib/project-policy.mjs': '5a2e78715a0daf68a7b3781211b0b0deaec04e61bf3e36b98597b9f0b885b32b',
  'scripts/lib/project-policy/dependency-policy.mjs':
    '680e848efac0e9515f236d942b1227ddd06c42b9d5742b3eb4eb1ec5770127ef',
  'scripts/lib/project-policy/generated-project-dependency-policy.json':
    '5af3732485a3aa12c15fc8e8835ac32ffc06f159ae96de07b580d319d56207fa',
  'scripts/lib/project-policy/source-policy.mjs': 'deed7d40e7c9c1bca8cfb3dbf46503f9dc89a4004988f8ef55871b7ed0c24f86',
  'scripts/lib/project-policy/worker-policy.mjs': '9f908807030d1a91c99b442b41488048d2e49b996783a18900b413e046f3edbc',
  'scripts/lib/project-policy/workflow-policy.mjs': 'e4c172b80ffe2f551a4ca25d4f8a4d0ea19195a7cef0ee056536e331d3993fab',
  'scripts/lib/project-policy/workspace-policy.mjs': '5c2f4a7e780b0f02762ca46967add61325195400c1eb8f2cea64bbba272bd60b',
  'scripts/provision-cloudflare-production.mjs': '2680b6345c9d9cdc99924fae8b7d1e1379d52a0a436610fbad2fff089733d922',
  'scripts/verify-production-config.mjs': 'd4dc49edde802b0038d55da0f0c8c52171ca1d68287b75f7fb36ce127310417b',
  'scripts/verify-production-licenses.mjs': '22952be32b45c416551ca2681a202b72c616aca61c6643ce946868373320a82d',
  'scripts/verify-stack-alignment.mjs': '615b04620071289b36ac4740dfc7f9a71b5a1f17516721bd8d78e6e60801bdeb',
  'src/agent-routing.ts': '0000bd8d4daa8b0b84d5e176c955b8ee0983e013b87079fa47414b79f7963b57',
  'src/agent-security.ts': '72f32a6bc2dd1b8d36c4f1c57dce2c00ed29ae30662e1f26b1d8011cdc8c8124',
  'src/agents/anonymous-retention.ts': '38489c93827bc38bcf48deac80005fbe03c6bbb31a6c4fe885c6064e22eb05ae',
  'src/agents/app-agent.ts': '4c59718f613bec05702540ed50b7a124a88655f22dfd96d2908680e167304f30',
  'src/agents/chat-policy.ts': '16a806aa0e26b5c7057e70fecb59cbbfd08921e36e8d2b967102eab6b7e6dec2',
  'src/app-bindings.ts': '88f1db64a430b254a3dc1cc901bb477ff065818a939732b145d9fbf2436606a5',
  'src/application-response.ts': 'b55a5bc163c3ac544569d1d1ac221ecb7a5ba5346ce24866f361e6f3b36c0e7b',
  'src/plain-server.ts': 'aa127a544cd5518123a98d029bd3d8200cf1ee0782c8b895f4bf03ac6a9d457d',
  'src/server.ts': '464dc8fc95be9e8f9a843a4aed82e9152afd0080b11ec6293855247f282a6c78',
  'src/workers-ai.shared.ts': '04a50a0d46bcb5a24dfe0a0d1d597112eed890e38ff11f384ebbdfba7ab26f0e',
  'tailwind.config.js': 'c43ce7f83ee3ef0259121fa47ebc98dcb67a25a106aea5318fb0559ce72bc558',
  'tsconfig.json': 'e0cbd86a85f24cfb860bf1d3eae61598c53367921332e42df43b918b8f6966e9',
  'vite.config.ts': '5879c27b4ef76847490b197bdf893136e46fec68c4af924be30ae6490656ee32',
} as const;

export const APP_AGENT_SECURITY_BOUNDARY_SHA256 = 'baf154355ecd22415600b5b1c96b3dca2e58d40739f8cdf020414d9c4ea508ad';

export const APP_AGENT_PROTECTED_LOCK_ENTRIES_SHA256 =
  'ed0c39c56c468e7205c3bfb5f75b7ab79ea9513e0371827effce30f46bda3176';

export function isCurrentDeploymentSecurityIdentity(value: {
  version?: unknown;
  templateSourceSha256?: unknown;
  securityBaselineVersion?: unknown;
  securityBoundarySha256?: unknown;
}): boolean {
  return (
    value.version === 5 &&
    value.templateSourceSha256 === TEMPLATE_SOURCE_SHA256 &&
    value.securityBaselineVersion === DEPLOYMENT_SECURITY_BASELINE_VERSION &&
    value.securityBoundarySha256 === APP_AGENT_SECURITY_BOUNDARY_SHA256
  );
}
