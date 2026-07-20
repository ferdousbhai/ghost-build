const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const esbuild = require('esbuild');
const shellSafeCommonJs = require('./shell-safe-commonjs.cjs');

async function buildEmbeddedBundle({ check = false, entryPoint, outputPath, shellSafe = false, ...options }) {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    minify: false,
    write: false,
    ...options,
  });
  const [output] = result.outputFiles ?? [];
  if (!output) {
    throw new Error(`esbuild did not produce output for ${entryPoint}.`);
  }

  const source = shellSafe ? shellSafeCommonJs(output.text) : output.text;
  if (check) {
    if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== source) {
      throw new Error(`${outputPath} is stale; run the embedded bundle build.`);
    }
    console.log(`Bundle is current: ${outputPath}`);
    return;
  }

  writeFileSync(outputPath, source, 'utf8');
  console.log(`Bundle written to ${outputPath}`);
}

module.exports = { buildEmbeddedBundle };
