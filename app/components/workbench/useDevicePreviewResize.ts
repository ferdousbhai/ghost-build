import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';

export type ResizeHandleSide = 'left' | 'right';

interface ResizeSession {
  side: ResizeHandleSide;
  startX: number;
  startWidthPercent: number;
  windowWidth: number;
}

const INITIAL_WIDTH_PERCENT = 37.5;
const SCALING_FACTOR = 2;
const KEYBOARD_STEP_PERCENT = 2.5;
const MIN_WIDTH_PERCENT = 10;
const MAX_WIDTH_PERCENT = 90;

function clampWidth(width: number): number {
  return Math.max(MIN_WIDTH_PERCENT, Math.min(width, MAX_WIDTH_PERCENT));
}

export function useDevicePreviewResize() {
  const [isDeviceModeOn, setIsDeviceModeOn] = useState(false);
  const [widthPercent, setWidthPercent] = useState(INITIAL_WIDTH_PERCENT);
  const [session, setSession] = useState<ResizeSession | null>(null);

  useEffect(() => {
    if (!session) {
      return undefined;
    }
    document.body.style.userSelect = 'none';
    const onMouseMove = (event: MouseEvent) => {
      const deltaPercent = ((event.clientX - session.startX) / session.windowWidth) * 100 * SCALING_FACTOR;
      const direction = session.side === 'left' ? -1 : 1;
      setWidthPercent(clampWidth(session.startWidthPercent + direction * deltaPercent));
    };
    const stop = () => setSession(null);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', stop);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', stop);
      document.body.style.userSelect = '';
    };
  }, [session]);

  const startResizing = useCallback(
    (event: ReactMouseEvent, side: ResizeHandleSide) => {
      if (!isDeviceModeOn) {
        return;
      }
      setSession({
        side,
        startX: event.clientX,
        startWidthPercent: widthPercent,
        windowWidth: window.innerWidth,
      });
      event.preventDefault();
    },
    [isDeviceModeOn, widthPercent],
  );

  return {
    adjustWidthWithKeyboard: (side: ResizeHandleSide, key: 'ArrowLeft' | 'ArrowRight') => {
      const pointerDirection = key === 'ArrowRight' ? 1 : -1;
      const widthDirection = side === 'left' ? -pointerDirection : pointerDirection;
      setWidthPercent((width) => clampWidth(width + widthDirection * KEYBOARD_STEP_PERCENT));
    },
    isDeviceModeOn,
    startResizing,
    toggleDeviceMode: () => setIsDeviceModeOn((enabled) => !enabled),
    widthPercent,
  };
}
