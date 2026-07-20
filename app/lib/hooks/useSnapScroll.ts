import { useRef, useCallback } from 'react';

/** Pixels from bottom to consider "scrolled to bottom" */
const BOTTOM_THRESHOLD = 50;

export function useSnapScroll() {
  const autoScrollRef = useRef(true);
  const scrollNodeRef = useRef<HTMLDivElement | null>(null);
  const onScrollRef = useRef<(() => void) | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastScrollTopRef = useRef<number>(0);

  const scrollToBottom = useCallback(() => {
    const scrollNode = scrollNodeRef.current;
    if (!autoScrollRef.current || !scrollNode) {
      return;
    }

    scrollNode.scrollTo({
      top: scrollNode.scrollHeight - scrollNode.clientHeight,
      behavior: 'smooth',
    });
  }, []);

  const messageRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        observerRef.current?.disconnect();
        observerRef.current = null;
        return;
      }

      const observer = new ResizeObserver(() => {
        scrollToBottom();
      });

      observer.observe(node);
      observerRef.current = observer;
    },
    [scrollToBottom],
  );

  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      if (onScrollRef.current && scrollNodeRef.current) {
        scrollNodeRef.current.removeEventListener('scroll', onScrollRef.current);
      }

      scrollNodeRef.current = null;
      onScrollRef.current = null;
      return;
    }

    onScrollRef.current = () => {
      const { scrollTop } = node;
      const isScrollingUp = scrollTop < lastScrollTopRef.current;

      if (isScrollingUp) {
        autoScrollRef.current = false;
      } else if (isScrolledToBottom(node)) {
        autoScrollRef.current = true;
      }

      lastScrollTopRef.current = scrollTop;
    };

    node.addEventListener('scroll', onScrollRef.current);
    scrollNodeRef.current = node;
  }, []);

  const enableAutoScroll = useCallback(() => {
    autoScrollRef.current = true;
  }, []);

  return { messageRef, scrollRef, enableAutoScroll };
}

function isScrolledToBottom(element: HTMLDivElement): boolean {
  const { scrollTop, scrollHeight, clientHeight } = element;
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_THRESHOLD;
}
