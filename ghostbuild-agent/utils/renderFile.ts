export function renderFile(content: string, viewRange?: [number, number]) {
  const lines = content.split('\n').map((line, index) => `${index + 1}: ${line}`);
  const [startLine, endLine] = viewRange ?? [1, -1];

  if (startLine < 1) {
    throw new Error('Invalid range: start must be greater than 0');
  }

  const selectedLines = lines.slice(startLine - 1, endLine === -1 ? undefined : endLine);

  //  The view tool result includes file contents with line numbers prepended to each line
  // (e.g., “1: def is_prime(n):”). Line numbers are not required, but they are essential
  // for successfully using the view_range parameter to examine specific sections of files
  // and the insert_line parameter to add content at precise locations.
  return selectedLines.join('\n');
}
