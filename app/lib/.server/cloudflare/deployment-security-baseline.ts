import templateSnapshotManifest from 'public/template-snapshot-manifest.json';

export const DEPLOYMENT_SECURITY_BASELINE_VERSION = 5 as const;
export const DEPLOYMENT_SECURITY_CLEANUP_CRON = '0 3 * * *';
export const DEPLOYMENT_VERSION_METADATA_BINDING = 'CF_VERSION_METADATA';
export const DEPLOYMENT_SECURITY_BASELINE_BINDING = 'GHOSTBUILD_SECURITY_BASELINE_VERSION';
export const DEPLOYMENT_TEMPLATE_SOURCE_BINDING = 'GHOSTBUILD_TEMPLATE_SOURCE_SHA256';
export const DEPLOYMENT_SECURITY_BOUNDARY_BINDING = 'GHOSTBUILD_SECURITY_BOUNDARY_SHA256';

export const TEMPLATE_SOURCE_SHA256 = templateSnapshotManifest.sourceSha256;

/**
 * These files form the generated AppAgent's authentication, inference-budget,
 * retention, and request-routing boundary. Exact digests deliberately make
 * automatic deployment fail closed when generated code changes that boundary.
 * A changed boundary must ship as a reviewed baseline before it can be
 * attested by the managed publisher.
 */
export const APP_AGENT_PROTECTED_FILE_SHA256 = {
  'src/server.ts': '464dc8fc95be9e8f9a843a4aed82e9152afd0080b11ec6293855247f282a6c78',
  'src/agent-routing.ts': '0000bd8d4daa8b0b84d5e176c955b8ee0983e013b87079fa47414b79f7963b57',
  'src/agent-security.ts': '72f32a6bc2dd1b8d36c4f1c57dce2c00ed29ae30662e1f26b1d8011cdc8c8124',
  'src/agents/app-agent.ts': '49f8f1de23e10d7f559905e7b19c9646e91c3efb86137d3824362defb4e1e7f7',
  'src/agents/anonymous-retention.ts': '38489c93827bc38bcf48deac80005fbe03c6bbb31a6c4fe885c6064e22eb05ae',
  'src/agents/chat-policy.ts': '16a806aa0e26b5c7057e70fecb59cbbfd08921e36e8d2b967102eab6b7e6dec2',
  'src/app-bindings.ts': '6f5fd82619b6bd55d20ee66428ad264aaf8dfee7b179efeb7cf3eb09906a7998',
  'src/application-response.ts': 'e937a8397d1734cf3b349dabbaa1d6e7925b8d8c2f1d111075f053595dea2370',
  'src/workers-ai.shared.ts': '04a50a0d46bcb5a24dfe0a0d1d597112eed890e38ff11f384ebbdfba7ab26f0e',
  'migrations/0001_app_data.sql': '114d3df6142196cb43a95e5896e1b9a8e8753514becf3400884b27acb5793d65',
  'agent-security-migrations/0001_agent_security.sql':
    'cc62c34bcfb5e176155e371a099d000679ae69877facf252fe3d3c7e1190fbeb',
  'vite.config.ts': 'be985dea26388476aae441a4e742da5d6f964bfc70f2958ed77e773de8c102f4',
  'tsconfig.json': 'a005fcf59f0217cc7486892312d032adad3e400f86c396d4150390247c989b6a',
  'postcss.config.cjs': 'fa650b380adfabb151a0b352f7135e107e6352345f899060f1c5c231228f94bf',
  'tailwind.config.js': 'c43ce7f83ee3ef0259121fa47ebc98dcb67a25a106aea5318fb0559ce72bc558',
  'eslint.config.js': 'a440b7f8bc1fb58656d21817e53dfde75fbbaf3afe6b59e9ef7d2f7ad699155d',
  'src/preview/agents-react.ts': '30d0966ea806e6a213b502b87b61c59606b27da2b8d8bf205dbd70fabfe040e1',
  'src/preview/agents.ts': 'dc202dcc357004a13ba106b9c35229484f4ac5c1273067473639ab4452efa27c',
  'src/preview/ai-chat-react.ts': 'fccec1499fb5b66a31430feddd7f1070dd8d7357e83e83368a688e3d9dd6c9d5',
  'src/preview/ai-chat.ts': 'eea156db8463ab280b8d44af1390e7cc40ef416134518a94e68ceface470ed27',
  'src/preview/workers-ai-provider.ts': '6bc1fd2c8e9154b7fd44fe4c2b4475d2c02311093c11c2fc90047d7d303111f1',
  'scripts/cf-typegen.mjs': '6c82a0afdb50c32b205dbe4677b207337a38ad7ea70950a3e63758f0c04e1ae7',
  'scripts/verify-stack-alignment.mjs': '24aa753cd35912056e32b3cf0cfc8a3784cb49702ecc5c635b1d9b53a7f07e17',
  'scripts/verify-production-licenses.mjs': '22952be32b45c416551ca2681a202b72c616aca61c6643ce946868373320a82d',
  'scripts/lib/production-license-artifact.mjs': 'e9ff7fc97973e4299f9a4b3026f148f3e32e6c2ff71d21bdbc40ae1e60d49892',
  'scripts/lib/runtime-module-security.ts': 'da536c84a63bb5e4c6ad4c301a64d329ac25b870c808f1df54a927022c7d6939',
  'scripts/lib/project-policy.mjs': '5a2e78715a0daf68a7b3781211b0b0deaec04e61bf3e36b98597b9f0b885b32b',
  'scripts/lib/project-policy/dependency-policy.mjs':
    '5ba6a6bd6d2f7ce4d1c64e2238d647d709ed9ea7c35ff312e9eb926606aa2298',
  'scripts/lib/project-policy/source-policy.mjs': 'deed7d40e7c9c1bca8cfb3dbf46503f9dc89a4004988f8ef55871b7ed0c24f86',
  'scripts/lib/project-policy/worker-policy.mjs': '9f908807030d1a91c99b442b41488048d2e49b996783a18900b413e046f3edbc',
  'scripts/lib/project-policy/workflow-policy.mjs': 'da9f44a45e16350d76a33474ce0efb0a3df56642ace1a605e93de4eb9789e027',
  'scripts/lib/project-policy/workspace-policy.mjs': '2eae19d07b13fcedf89bb0825bc99ee0a803493cbf10bfad2d557c46820ec3f5',
} as const;

export const APP_AGENT_SECURITY_BOUNDARY_SHA256 = '2e5e631b9641a81008e519ac94d90a2c715c5372a8555ee563bfc4e7c2631e5b';

export const APP_AGENT_PROTECTED_LOCK_ENTRIES_SHA256 =
  '32df8c2fea1562044c38b9faabc729e046737de4c833b83e6d7087e4b392682a';

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
