function stripOscSequences(input: string): string {
  return input.replace(/\x1b\](\d+;[^\x07\x1b]*|\d+[^\x07\x1b]*)\x07/g, '').replace(/\](\d+;[^\n]*|\d+[^\n]*)/g, '');
}

function stripAnsiSequences(input: string): string {
  return input.replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '').replace(/\x1b/g, '');
}

function normalizeLineEndings(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function separateTerminalSections(input: string): string {
  return input
    .replace(/^([~/][^\n❯]+)❯/m, '$1\n❯')
    .replace(/(?<!^|\n)>/g, '\n>')
    .replace(/(?<!^|\n|\w)(error|failed|warning|Error|Failed|Warning):/g, '\n$1:')
    .replace(/(?<!^|\n|\/)(at\s+(?!async|sync))/g, '\nat ')
    .replace(/\bat\s+async/g, 'at async')
    .replace(/(?<!^|\n)(npm ERR!)/g, '\n$1');
}

function trimOutputLines(input: string): string {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function normalizeOutputWhitespace(input: string): string {
  return input
    .replace(/\n{3,}/g, '\n\n')
    .replace(/:\s+/g, ': ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\u0000/g, '');
}

export function cleanTerminalOutput(input: string): string {
  const withoutOsc = stripOscSequences(input);
  const withoutAnsi = stripAnsiSequences(withoutOsc);
  const normalizedLines = normalizeLineEndings(withoutAnsi);
  const separatedSections = separateTerminalSections(normalizedLines);
  const trimmedLines = trimOutputLines(separatedSections);
  return normalizeOutputWhitespace(trimmedLines);
}
