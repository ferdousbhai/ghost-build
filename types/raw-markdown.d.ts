/** Markdown bundled into the Worker as text, e.g. the builder skills shipped in this repository. */
declare module '*.md?raw' {
  const content: string;
  export default content;
}
