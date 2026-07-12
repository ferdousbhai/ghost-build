import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { docs, lookupDocsParameters, type DocKey } from 'ghostbuild-agent/tools/lookupDocs';

export function runLookupDocs(invocation: GhostbuildToolInvocation): string {
  const args = lookupDocsParameters.parse(invocation.args);
  return args.docs
    .map((doc) => {
      if (!(doc in docs)) {
        throw new Error(`Could not find documentation for component: ${doc}. It may not yet be supported.`);
      }
      return docs[doc as DocKey];
    })
    .join('\n\n');
}
