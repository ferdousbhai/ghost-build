import {
  createdBundledHighlighter,
  createJavaScriptRegexEngine,
  makeSingletonHighlighter,
  type SpecialLanguage,
} from 'shiki/core';

const languages = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  shell: () => import('shiki/langs/shell.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};

const themes = {
  'dark-plus': () => import('shiki/themes/dark-plus.mjs'),
  'github-dark': () => import('shiki/themes/github-dark.mjs'),
  'github-light': () => import('shiki/themes/github-light.mjs'),
  'light-plus': () => import('shiki/themes/light-plus.mjs'),
};

export type CodeLanguage = keyof typeof languages;
export type CodeTheme = keyof typeof themes;
export type HighlightLanguage = CodeLanguage | SpecialLanguage;

const languageAliases: Record<string, HighlightLanguage> = {
  bash: 'bash',
  c: 'c',
  'c++': 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  csharp: 'csharp',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  javascript: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  markdown: 'markdown',
  php: 'php',
  plaintext: 'plaintext',
  py: 'python',
  python: 'python',
  rb: 'ruby',
  rs: 'rust',
  rust: 'rust',
  sh: 'bash',
  shell: 'shell',
  sql: 'sql',
  swift: 'swift',
  text: 'plaintext',
  ts: 'typescript',
  tsx: 'tsx',
  typescript: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

const createCodeHighlighter = createdBundledHighlighter({
  langs: languages,
  themes,
  engine: createJavaScriptRegexEngine,
});

export const getCodeHighlighter = makeSingletonHighlighter(createCodeHighlighter);

export function normalizeCodeLanguage(language: string | undefined): HighlightLanguage {
  return languageAliases[language?.toLowerCase().replace(/^\./, '') ?? ''] ?? 'plaintext';
}
