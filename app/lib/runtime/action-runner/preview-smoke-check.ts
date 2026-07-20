export function createPreviewSmokeCheckScript(port: number, timeoutMs: number): string {
  return `
const previewUrl = "http://127.0.0.1:${port}/";
const timeoutAt = Date.now() + ${timeoutMs};
const badMarkers = [
  "An error occurred while server rendering",
  "Invalid or unexpected token",
  "ERR_UNSUPPORTED_ESM_URL_SCHEME",
  "Internal server error",
  "Cannot find package",
  "Failed to resolve import",
  "Failed to load url",
];
let lastError;

function previewBodyExcerpt(body, marker) {
  const cleanBody = body
    .replace(/<script[\\s\\S]*?<\\/script>/gi, "")
    .replace(/<style[\\s\\S]*?<\\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
  if (!marker) return cleanBody.slice(0, 2000);
  const markerIndex = cleanBody.indexOf(marker);
  if (markerIndex === -1) return cleanBody.slice(0, 2000);
  return cleanBody.slice(Math.max(0, markerIndex - 800), markerIndex + 2200);
}

while (Date.now() < timeoutAt) {
  try {
    const response = await fetch(previewUrl, { signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    const badMarker = badMarkers.find((marker) => body.includes(marker));
    if (!response.ok || badMarker) {
      const reason = badMarker ? \`preview contained "\${badMarker}"\` : \`preview returned HTTP \${response.status}\`;
      throw new Error(\`\${reason}\\n\${previewBodyExcerpt(body, badMarker)}\`);
    }
    if (body.trim().length === 0) throw new Error("preview returned an empty response");
    console.log("Preview smoke check passed.");
    process.exit(0);
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

throw new Error(\`Preview did not render cleanly before timeout: \${lastError?.message ?? lastError}\`);
`;
}
