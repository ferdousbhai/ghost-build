import { readFileSync } from 'node:fs';
import * as lz4 from 'lz4-wasm-nodejs';

// Usage `node parse-compressed-messages.mjs <path-to-file> | jq`
// e.g. a file downloaded from the Ghostbuild backend containing message history

// Check if file path is provided
if (process.argv.length < 3) {
  console.error('Please provide a file path');
  process.exit(1);
}

const filePath = process.argv[2];

try {
  const compressedData = readFileSync(filePath);
  const decompressedBuffer = lz4.decompress(compressedData);
  const jsonData = JSON.parse(new TextDecoder().decode(decompressedBuffer));
  console.log(JSON.stringify(jsonData, null, 2));
} catch (error) {
  console.error('Error processing file:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
