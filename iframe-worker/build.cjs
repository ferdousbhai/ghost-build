const path = require('node:path');
const { buildEmbeddedBundle } = require('../scripts/build-embedded-bundle.cjs');

buildEmbeddedBundle({
  check: process.argv.includes('--check'),
  entryPoint: path.join(__dirname, 'worker.mts'),
  outputPath: path.join(__dirname, 'worker.bundled.mjs'),
  absWorkingDir: __dirname,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
