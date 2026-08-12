import { parseSystemDocsBundle, SYSTEM_DOCS_PUBLISHED_KEY, type SystemDocsBundle } from 'ghostbuild-agent/system-docs';

export async function loadSystemDocs(namespace: KVNamespace): Promise<SystemDocsBundle | null> {
  return parseSystemDocsBundle(await namespace.get(SYSTEM_DOCS_PUBLISHED_KEY, 'text'));
}
