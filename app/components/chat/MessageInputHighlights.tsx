import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEventHandler,
  type KeyboardEventHandler,
  type RefObject,
} from 'react';
import { Tooltip } from '@ui/Tooltip';
import { classNames } from '~/utils/classNames';
import { MAX_USER_MESSAGE_CHARACTERS } from 'ghostbuild-agent/context-limits';

export interface MessageInputHighlight {
  text: string;
  tooltip: string;
}

export const MESSAGE_INPUT_HIGHLIGHTS: MessageInputHighlight[] = [
  {
    text: 'ai chat',
    tooltip: 'Ghostbuild will prototype AI features with Cloudflare Workers AI and your selected builder model.',
  },
  {
    text: 'collaborative text editor',
    tooltip:
      'Ghostbuild will use Cloudflare Agents or Durable Objects for coordination and TanStack DB for local live state.',
  },
  {
    text: 'upload',
    tooltip: 'Ghostbuild will use Cloudflare R2 for object storage and Worker routes for signed upload flows.',
  },
  {
    text: 'full text search',
    tooltip: 'Ghostbuild will use Cloudflare D1, Vectorize, or Worker-backed search APIs depending on the data model.',
  },
  {
    text: 'presence',
    tooltip: 'Ghostbuild will use Cloudflare Agents or Durable Objects for durable realtime presence state.',
  },
];

interface HighlightBlock {
  from: number;
  length: number;
  tip: string;
}

interface TextareaWithHighlightsProps {
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  value: string;
  placeholder: string;
  disabled: boolean;
  minHeight: number;
  maxHeight: number;
  highlights: MessageInputHighlight[];
  contentClassName?: string;
}

export const TextareaWithHighlights = memo(function TextareaWithHighlights({
  onKeyDown,
  onChange,
  value,
  minHeight,
  maxHeight,
  placeholder,
  disabled,
  highlights,
  contentClassName,
}: TextareaWithHighlightsProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [value]);

  const blocks = useMemo(() => findHighlightBlocks(value, highlights), [highlights, value]);
  return (
    <div className="relative overflow-y-auto" style={{ minHeight, maxHeight }}>
      <textarea
        ref={textareaRef}
        className={classNames(
          'block w-full appearance-none resize-none bg-transparent px-3 py-3 text-sm leading-snug text-content-primary outline-none placeholder-content-tertiary',
          'transition-opacity',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'scrollbar-thin scrollbar-track-transparent scrollbar-thumb-macosScrollbar-thumb',
          contentClassName,
        )}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onChange={onChange}
        value={value}
        style={{ minHeight }}
        placeholder={placeholder}
        aria-label={placeholder}
        translate="no"
        data-gramm="false"
        maxLength={MAX_USER_MESSAGE_CHARACTERS}
      />
      <HighlightBlocks textareaRef={textareaRef} text={value} blocks={blocks} contentClassName={contentClassName} />
    </div>
  );
});

export function findHighlightBlocks(value: string, highlights: MessageInputHighlight[]): HighlightBlock[] {
  const tooltips = new Map(highlights.map((highlight) => [highlight.text, highlight.tooltip]));
  const pattern = highlights.map((highlight) => highlight.text).join('|');
  if (!pattern) {
    return [];
  }
  return Array.from(value.matchAll(new RegExp(pattern, 'gi'))).map((match) => ({
    from: match.index,
    length: match[0].length,
    tip: tooltips.get(match[0].toLowerCase()) ?? '',
  }));
}

const HighlightBlocks = memo(function HighlightBlocks({
  text,
  blocks,
  textareaRef,
  contentClassName,
}: {
  text: string;
  blocks: HighlightBlock[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  contentClassName?: string;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [resizeVersion, setResizeVersion] = useState(0);
  const [positions, setPositions] = useState<Array<HighlightBlock & DOMRectShape>>([]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return undefined;
    }
    const observer = new ResizeObserver(() => setResizeVersion((version) => version + 1));
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [textareaRef]);

  useLayoutEffect(() => {
    if (!blocks.length) {
      setPositions([]);
      return;
    }
    const mirror = mirrorRef.current;
    const textNode = mirror?.firstChild;
    if (!mirror || !textNode) {
      return;
    }
    const wrapperRect = mirror.getBoundingClientRect();
    setPositions(
      blocks.flatMap((block) => {
        const range = document.createRange();
        range.setStart(textNode, block.from);
        range.setEnd(textNode, block.from + block.length);
        return Array.from(range.getClientRects()).map((rect) => ({
          ...block,
          top: rect.top - wrapperRect.top + mirror.scrollTop,
          left: rect.left - wrapperRect.left + mirror.scrollLeft,
          width: rect.width,
          height: rect.height,
        }));
      }),
    );
  }, [blocks, resizeVersion]);

  if (!blocks.length) {
    return null;
  }
  return (
    <div>
      <div
        ref={mirrorRef}
        className={classNames(
          'pointer-events-none absolute inset-0 -z-20 whitespace-pre-wrap break-words p-3 text-sm leading-snug opacity-0',
          contentClassName,
        )}
        aria-hidden
      >
        {text}
      </div>
      <div>
        {positions.map((position, index) => (
          <HighlightTooltip key={index} {...position} />
        ))}
      </div>
    </div>
  );
});

interface DOMRectShape {
  top: number;
  left: number;
  width: number;
  height: number;
}

function HighlightTooltip({ tip, top, left, width, height }: HighlightBlock & DOMRectShape) {
  return (
    <div className="absolute flex overflow-hidden bg-[#f8d077] mix-blend-color" style={{ top, left, width, height }}>
      <Tooltip className="absolute inset-0" tip={tip}>
        {null}
      </Tooltip>
    </div>
  );
}
