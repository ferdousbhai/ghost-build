import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import rehypeSanitize, { defaultSchema, type Options as RehypeSanitizeOptions } from 'rehype-sanitize';
import { visit } from 'unist-util-visit';
import type { Node as UnistNode } from 'unist';
import { allowedHTMLElements } from 'ghostbuild-agent/prompts/formattingInstructions';

type HtmlNode = UnistNode & {
  type: 'html';
  value?: string;
};

function isHtmlNode(node: UnistNode): node is HtmlNode {
  return node.type === 'html';
}

// Add custom rehype plugin
function remarkThinkRawContent() {
  return (tree: UnistNode) => {
    visit(tree, (node: UnistNode) => {
      if (isHtmlNode(node) && node.value?.startsWith('<think>')) {
        const cleanedContent = node.value.slice(7);
        node.value = `<div class="__ghostbuildThought__">${cleanedContent}`;

        return;
      }

      if (isHtmlNode(node) && node.value?.startsWith('</think>')) {
        const cleanedContent = node.value.slice(8);
        node.value = `</div>${cleanedContent}`;
      }
    });
  };
}

const rehypeSanitizeOptions: RehypeSanitizeOptions = {
  ...defaultSchema,
  tagNames: allowedHTMLElements,
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div ?? []), 'data*', ['className', '__ghostbuildThought__']],
  },
  strip: [],
};

export const markdownRemarkPlugins: PluggableList = [remarkThinkRawContent, remarkGfm];

// rehypeRaw parses untrusted model/user HTML, so sanitization must remain the final rehype transform.
export const markdownRehypePlugins: PluggableList = [rehypeRaw, [rehypeSanitize, rehypeSanitizeOptions]];
