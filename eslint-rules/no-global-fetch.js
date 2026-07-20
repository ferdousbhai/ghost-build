// @ts-check
/**
 * @type {import('eslint').Rule.RuleModule}
 */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct global fetch usage in AI streaming code; use ~/lib/.server/fetch',
      category: 'Best Practices',
      recommended: false,
    },
    messages: {
      noGlobalFetch:
        'Do not use global fetch directly in AI streaming code. Import fetch from ~/lib/.server/fetch so Cloudflare runtime behavior stays centralized.',
    },
    schema: [],
  },
  create(context) {
    let allowedFetchNames = new Set();

    return {
      ImportDeclaration(node) {
        if (node.source.value === '~/lib/.server/fetch') {
          for (const spec of node.specifiers) {
            if (
              spec.type === 'ImportSpecifier' &&
              spec.imported.type === 'Identifier' &&
              spec.imported.name === 'fetch'
            ) {
              allowedFetchNames.add(spec.local.name);
            }
          }
        }
      },
      Identifier(node) {
        if (
          node.name === 'fetch' &&
          !allowedFetchNames.has('fetch') &&
          node.parent &&
          node.parent.type !== 'ImportSpecifier' &&
          node.parent.type !== 'ImportDeclaration'
        ) {
          context.report({
            node,
            messageId: 'noGlobalFetch',
          });
        }
      },
    };
  },
};

export default rule;
