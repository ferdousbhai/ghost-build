import { useCallback, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  adjacentWorkspaceSurface,
  currentWorkspaceSurface,
  selectWorkspaceSurface,
  type WorkspaceSurface,
} from '~/lib/stores/workspace-surface.client';

const SWIPE_DISTANCE_PX = 56;
const SWIPE_FAST_DISTANCE_PX = 32;
const SWIPE_VELOCITY_PX_PER_MS = 0.5;
const SWIPE_AXIS_RATIO = 1.25;
const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, iframe, [contenteditable="true"], [role="textbox"]';

type SwipeStart = {
  pointerId: number;
  x: number;
  y: number;
  startedAt: number;
};

export function useWorkspaceSwipe(enabled: boolean) {
  const startRef = useRef<SwipeStart | null>(null);
  const suppressClickRef = useRef(false);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.pointerType !== 'touch' || !event.isPrimary || shouldIgnoreSwipeStart(event)) {
        return;
      }
      startRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startedAt: performance.now(),
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [enabled],
  );

  const finishSwipe = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const start = startRef.current;
    startRef.current = null;
    if (!start || start.pointerId !== event.pointerId) {
      return;
    }
    const surface = resolveWorkspaceSwipe({
      surface: currentWorkspaceSurface(),
      deltaX: event.clientX - start.x,
      deltaY: event.clientY - start.y,
      elapsedMs: performance.now() - start.startedAt,
    });
    if (!surface) {
      return;
    }
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    selectWorkspaceSurface(surface);
  }, []);

  const onPointerCancel = useCallback(() => {
    startRef.current = null;
  }, []);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) {
      return;
    }
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { onClickCapture, onPointerCancel, onPointerDown, onPointerUp: finishSwipe };
}

function resolveWorkspaceSwipe({
  surface,
  deltaX,
  deltaY,
  elapsedMs,
}: {
  surface: WorkspaceSurface;
  deltaX: number;
  deltaY: number;
  elapsedMs: number;
}): WorkspaceSurface | null {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  const velocity = horizontalDistance / Math.max(1, elapsedMs);
  const deliberate = horizontalDistance >= SWIPE_DISTANCE_PX;
  const fast = horizontalDistance >= SWIPE_FAST_DISTANCE_PX && velocity >= SWIPE_VELOCITY_PX_PER_MS;
  if ((!deliberate && !fast) || horizontalDistance < verticalDistance * SWIPE_AXIS_RATIO) {
    return null;
  }
  return adjacentWorkspaceSurface(surface, deltaX < 0 ? 'next' : 'previous');
}

function shouldIgnoreSwipeStart(event: ReactPointerEvent<HTMLElement>): boolean {
  return event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR) !== null;
}
