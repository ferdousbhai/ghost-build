export function renderFile(content: string) {
  const lines = content.split('\n').map((line, index) => `${index + 1}: ${line}`);

  // Prefix context with line numbers so the model can request a narrower read when needed.
  return lines.join('\n');
}
