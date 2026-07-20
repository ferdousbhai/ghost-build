import { LanguageDescription } from '@codemirror/language';

const supportedLanguages = [
  LanguageDescription.of({
    name: 'VUE',
    extensions: ['vue'],
    load() {
      return import('@codemirror/lang-vue').then((module) => module.vue());
    },
  }),
  LanguageDescription.of({
    name: 'TS',
    extensions: ['ts'],
    load() {
      return import('@codemirror/lang-javascript').then((module) => module.javascript({ typescript: true }));
    },
  }),
  LanguageDescription.of({
    name: 'JS',
    extensions: ['js', 'mjs', 'cjs'],
    load() {
      return import('@codemirror/lang-javascript').then((module) => module.javascript());
    },
  }),
  LanguageDescription.of({
    name: 'TSX',
    extensions: ['tsx'],
    load() {
      return import('@codemirror/lang-javascript').then((module) => module.javascript({ jsx: true, typescript: true }));
    },
  }),
  LanguageDescription.of({
    name: 'JSX',
    extensions: ['jsx'],
    load() {
      return import('@codemirror/lang-javascript').then((module) => module.javascript({ jsx: true }));
    },
  }),
  LanguageDescription.of({
    name: 'HTML',
    extensions: ['html'],
    load() {
      return import('@codemirror/lang-html').then((module) => module.html());
    },
  }),
  LanguageDescription.of({
    name: 'CSS',
    extensions: ['css'],
    load() {
      return import('@codemirror/lang-css').then((module) => module.css());
    },
  }),
  LanguageDescription.of({
    name: 'SASS',
    extensions: ['sass'],
    load() {
      return import('@codemirror/lang-sass').then((module) => module.sass({ indented: true }));
    },
  }),
  LanguageDescription.of({
    name: 'SCSS',
    extensions: ['scss'],
    load() {
      return import('@codemirror/lang-sass').then((module) => module.sass({ indented: false }));
    },
  }),
  LanguageDescription.of({
    name: 'JSON',
    extensions: ['json'],
    load() {
      return import('@codemirror/lang-json').then((module) => module.json());
    },
  }),
  LanguageDescription.of({
    name: 'Markdown',
    extensions: ['md'],
    load() {
      return import('@codemirror/lang-markdown').then((module) => module.markdown());
    },
  }),
  LanguageDescription.of({
    name: 'Wasm',
    extensions: ['wat'],
    load() {
      return import('@codemirror/lang-wast').then((module) => module.wast());
    },
  }),
  LanguageDescription.of({
    name: 'Python',
    extensions: ['py'],
    load() {
      return import('@codemirror/lang-python').then((module) => module.python());
    },
  }),
  LanguageDescription.of({
    name: 'C++',
    extensions: ['cpp'],
    load() {
      return import('@codemirror/lang-cpp').then((module) => module.cpp());
    },
  }),
];

export function getLanguage(fileName: string) {
  const languageDescription = LanguageDescription.matchFilename(supportedLanguages, fileName);
  return languageDescription?.load() ?? Promise.resolve(undefined);
}
