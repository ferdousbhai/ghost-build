import { memo, useEffect, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { CheckIcon, ClipboardIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { getCodeHighlighter, normalizeCodeLanguage, type CodeTheme, type HighlightLanguage } from '~/lib/shiki.client';

interface CodeBlockProps {
  className?: string;
  code: string;
  language?: string;
  theme?: CodeTheme;
  disableCopy?: boolean;
}

export const CodeBlock = memo(function CodeBlock({
  className,
  code,
  language = 'plaintext',
  theme = 'dark-plus',
  disableCopy = false,
}: CodeBlockProps) {
  const [html, setHTML] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    if (copied) {
      return;
    }

    navigator.clipboard.writeText(code);

    setCopied(true);

    setTimeout(() => {
      setCopied(false);
    }, 1000);
  };

  useEffect(() => {
    const normalizedLanguage = normalizeCodeLanguage(language);
    let active = true;

    getCodeHighlighter({
      langs: isLoadableLanguage(normalizedLanguage) ? [normalizedLanguage] : [],
      themes: [theme],
    }).then((highlighter) => {
      if (active) {
        setHTML(highlighter.codeToHtml(code, { lang: normalizedLanguage, theme }));
      }
    });

    return () => {
      active = false;
    };
  }, [code, language, theme]);

  return (
    <div className={classNames('relative group', className)}>
      <div
        className={classNames('absolute top-2 right-2 opacity-0 group-hover:opacity-100', {
          'opacity-100': copied,
        })}
      >
        {!disableCopy && (
          <Button
            variant="neutral"
            icon={copied ? <CheckIcon className="text-util-success" /> : <ClipboardIcon />}
            onClick={() => copyToClipboard()}
            tip="Copy Code"
          />
        )}
      </div>
      <div dangerouslySetInnerHTML={{ __html: html ?? '' }}></div>
    </div>
  );
});

function isLoadableLanguage(language: HighlightLanguage): language is Exclude<HighlightLanguage, 'plaintext' | 'text'> {
  return language !== 'plaintext' && language !== 'text';
}
