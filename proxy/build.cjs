const path = require('node:path');
const { buildEmbeddedBundle } = require('../scripts/build-embedded-bundle.cjs');

const stubFollowRedirectsPlugin = {
  name: 'stub-follow-redirects-plugin',
  setup(build) {
    build.onResolve({ filter: /^follow-redirects$/ }, (args) => ({
      path: args.path,
      namespace: 'stub-follow-redirects',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub-follow-redirects' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
  },
};

buildEmbeddedBundle({
  check: process.argv.includes('--check'),
  entryPoint: path.join(__dirname, 'proxy.cjs'),
  outputPath: path.join(__dirname, 'proxy.bundled.cjs'),
  absWorkingDir: __dirname,
  platform: 'node',
  target: 'node16',
  plugins: [stubFollowRedirectsPlugin],
  shellSafe: true,
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
