import { useStore } from '@nanostores/react';
import { FolderIcon } from '@heroicons/react/24/outline';
import { FileIcon } from '@radix-ui/react-icons';
import { memo } from 'react';
import { isToolInvocationInProgress, type GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { isGhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { viewToolInputParameters } from 'ghostbuild-agent/tools/view';
import { path } from 'ghostbuild-agent/utils/path';
import { loggingSafeParse } from 'ghostbuild-agent/utils/zodUtil';
import { normalizeCodeLanguage, type CodeTheme } from '~/lib/shiki.client';
import { themeStore } from '~/lib/stores/theme';
import { highlightTokenStyle, useHighlightedCode } from './useHighlightedCode';

export function ToolViewResult({ invocation }: { invocation: GhostbuildToolInvocation }) {
  if (invocation.toolName !== 'view') {
    throw new Error('View result expected a view invocation.');
  }
  if (isToolInvocationInProgress(invocation)) {
    return null;
  }
  const structured = structuredContent(invocation.result);
  const resultText = structured ?? (typeof invocation.result === 'string' ? invocation.result : '');
  if (resultText.startsWith('Error:')) {
    return <ResultFrame>{resultText}</ResultFrame>;
  }
  if (resultText.startsWith('Directory:')) {
    return (
      <div className="text-content-primary space-y-1 rounded-lg border p-4 font-mono text-sm">
        {resultText
          .split('\n')
          .slice(1)
          .map((item, index) => {
            const isDirectory = item.includes('(dir)');
            const label = item.replace('(dir)', '').replace('(file)', '').replace('- ', '').trim();
            return (
              <div key={index} className="flex items-center gap-2">
                {isDirectory ? <FolderIcon className="size-4" /> : <FileIcon />}
                {label}
              </div>
            );
          })}
      </div>
    );
  }

  const lines = structured
    ? structured.split('\n')
    : resultText.split('\n').map((line) => line.split(':').slice(1).join(':'));
  const args = loggingSafeParse(viewToolInputParameters, invocation.args);
  const language = args.success ? normalizeCodeLanguage(path.extname(args.data.path)) : 'typescript';
  const structuredStartLine =
    isGhostbuildToolResult(invocation.result) && typeof invocation.result.data === 'object' && invocation.result.data
      ? (invocation.result.data as { pageLineStart?: unknown }).pageLineStart
      : undefined;
  const startLine =
    typeof structuredStartLine === 'number'
      ? structuredStartLine
      : args.success && args.data.view_range
        ? args.data.view_range[0]
        : 1;
  return <LineNumberViewer lines={lines} startLineNumber={startLine} language={language} />;
}

const LineNumberViewer = memo(function LineNumberViewer({
  lines,
  startLineNumber,
  language,
}: {
  lines: string[];
  startLineNumber: number;
  language: string;
}) {
  const theme = useStore(themeStore);
  const normalizedLanguage = normalizeCodeLanguage(language);
  const codeTheme: CodeTheme = theme === 'dark' ? 'github-dark' : 'github-light';
  const highlightedLines = useHighlightedCode(lines.join('\n'), normalizedLanguage, codeTheme)?.tokens;

  return (
    <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
      <div className="max-h-[400px] overflow-auto">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, index) => (
              <tr key={index} className="group">
                <td className="text-content-tertiary w-12 select-none border-r bg-bolt-elements-background-depth-1 px-4 py-1 text-right">
                  {index + startLineNumber}
                </td>
                <td className="whitespace-pre py-1 group-hover:bg-bolt-elements-background-depth-2">
                  {highlightedLines ? (
                    highlightedLines[index]?.map((token, tokenIndex) => (
                      <span key={tokenIndex} style={highlightTokenStyle(token)}>
                        {token.content || ' '}
                      </span>
                    ))
                  ) : (
                    <span>{line || ' '}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

function structuredContent(result: unknown): string | undefined {
  if (!isGhostbuildToolResult(result) || typeof result.data !== 'object' || result.data === null) {
    return undefined;
  }
  const content = (result.data as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

function ResultFrame({ children }: { children: string }) {
  return (
    <div className="text-content-primary overflow-hidden rounded-lg border bg-bolt-elements-background-depth-1 font-mono text-sm">
      <div className="max-h-[400px] overflow-auto p-4">{children}</div>
    </div>
  );
}
