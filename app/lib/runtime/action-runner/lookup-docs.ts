import { docs, lookupDocsParameters, type DocKey } from 'ghostbuild-agent/tools/lookupDocs';
import { toolSuccess } from 'ghostbuild-agent/tool-result';
import { continuationCursor, continuationOffset, pageCoverage, textPage } from './bounded-pagination';
import { contentRevision, queryFingerprint } from './revision';

export async function runLookupDocs(input: unknown) {
  const args = lookupDocsParameters.parse(input);
  const selected = args.docs
    .map((doc) => {
      if (!(doc in docs)) {
        throw new Error(`Could not find documentation for component: ${doc}. It may not yet be supported.`);
      }
      const content = docs[doc as DocKey];
      const sections = selectSections(content, args.section, args.query);
      if (sections.length === 0) {
        throw new Error(
          `No documentation section matched ${args.section ? `heading ${JSON.stringify(args.section)}` : `query ${JSON.stringify(args.query)}`} in ${doc}.`,
        );
      }
      return `# ${doc}\n\n${sections.join('\n\n')}`;
    })
    .join('\n\n');
  const revision = await contentRevision(selected);
  const fingerprint = await queryFingerprint({
    tool: 'lookupDocs',
    docs: args.docs,
    section: args.section,
    query: args.query,
  });
  const page = textPage(selected, continuationOffset(args.cursor, { revision, fingerprint }));
  const nextCursor = page.complete ? undefined : continuationCursor(revision, fingerprint, page.end);
  return toolSuccess(
    `Returned documentation characters ${page.start}-${page.end} of ${page.total} from ${args.docs.join(', ')}.`,
    { content: page.content },
    pageCoverage(page, nextCursor),
  );
}

function selectSections(content: string, section: string | undefined, query: string | undefined): string[] {
  if (!section && !query) {
    return [content];
  }
  const sections = splitMarkdownSections(content);
  if (section) {
    const normalized = section.trim().toLocaleLowerCase();
    return sections.filter(({ heading }) => heading.toLocaleLowerCase() === normalized).map(({ content }) => content);
  }
  const terms = query!.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sections
    .filter(({ content: candidate }) => {
      const normalized = candidate.toLocaleLowerCase();
      return terms.every((term) => normalized.includes(term));
    })
    .map(({ content: candidate }) => candidate);
}

function splitMarkdownSections(content: string): Array<{ heading: string; content: string }> {
  const lines = content.split('\n');
  const sections: Array<{ heading: string; content: string }> = [];
  let heading = '';
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      sections.push({ heading, content: current.join('\n').trim() });
    }
  };
  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (match) {
      flush();
      heading = match[1];
      current = [line];
    } else {
      current.push(line);
    }
  }
  flush();
  return sections.filter(({ content: candidate }) => candidate.length > 0);
}
