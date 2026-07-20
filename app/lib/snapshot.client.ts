import { IGNORED_RELATIVE_PATHS } from '~/utils/constants';
import { webcontainer } from './webcontainer';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';

const logger = createScopedLogger('Snapshot');

export async function buildUncompressedSnapshot(): Promise<Uint8Array> {
  const container = await webcontainer;
  const start = Date.now();
  const snapshot = await container.export('.', {
    excludes: IGNORED_RELATIVE_PATHS,
    format: 'binary',
  });
  const end = Date.now();
  logger.debug(`Built snapshot in ${end - start}ms`);
  return snapshot;
}
