import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { rehypePlugins, remarkPlugins } from '~/utils/markdown';
import { allowedHTMLElements } from 'ghostbuild-agent/prompts/formattingInstructions';
import { CodeBlock } from './CodeBlock';

import styles from './Markdown.module.css';

const logger = createScopedLogger('MarkdownComponent');

interface MarkdownProps {
  children: string;
  html?: boolean;
  limitedMarkdown?: boolean;
}

export const Markdown = memo(function Markdown({ children, html = false, limitedMarkdown = false }: MarkdownProps) {
  logger.trace('Render');

  const components: Components = useMemo(() => {
    return {
      pre: (props) => {
        const { children, node, ...rest } = props;
        const [firstChild] = node?.children ?? [];

        if (
          firstChild &&
          firstChild.type === 'element' &&
          firstChild.tagName === 'code' &&
          firstChild.children[0].type === 'text'
        ) {
          const { className, ...rest } = firstChild.properties;
          const [, language = 'plaintext'] = /language-(\w+)/.exec(String(className) || '') ?? [];

          return <CodeBlock code={firstChild.children[0].value} language={language} {...rest} />;
        }

        return <pre {...rest}>{children}</pre>;
      },
    } satisfies Components;
  }, []);

  return (
    <ReactMarkdown
      allowedElements={allowedHTMLElements}
      className={styles.MarkdownContent}
      components={components}
      remarkPlugins={remarkPlugins(limitedMarkdown)}
      rehypePlugins={rehypePlugins(html)}
    >
      {children}
    </ReactMarkdown>
  );
});
