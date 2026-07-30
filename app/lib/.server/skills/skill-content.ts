const MAX_SKILL_BYTES = 256 * 1024;
const textEncoder = new TextEncoder();

export function validateUpstreamSkillContent(content: string, expectedName: string): Uint8Array {
  const bytes = textEncoder.encode(content);
  if (bytes.byteLength < 32 || bytes.byteLength > MAX_SKILL_BYTES) {
    throw new Error(`Upstream skill ${expectedName} has an invalid byte length.`);
  }
  if (content.includes('\0') || !content.startsWith('---\n')) {
    throw new Error(`Upstream skill ${expectedName} has invalid Markdown frontmatter.`);
  }
  const frontmatterEnd = content.indexOf('\n---\n', 4);
  if (frontmatterEnd < 0) {
    throw new Error(`Upstream skill ${expectedName} has unterminated Markdown frontmatter.`);
  }
  const frontmatter = content.slice(4, frontmatterEnd);
  const name = /^name:\s*(['"]?)([^'"\r\n]+)\1\s*$/m.exec(frontmatter)?.[2]?.trim();
  if (name !== expectedName || !/^description:\s*\S+/m.test(frontmatter)) {
    throw new Error(`Upstream skill ${expectedName} has unexpected frontmatter.`);
  }
  return bytes;
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = value instanceof ArrayBuffer ? value : Uint8Array.from(value).buffer;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
