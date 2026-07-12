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
      setWidthPercent(Math.max(10, Math.min(session.startWidthPercent + direction * deltaPercent, 90)));
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
    isDeviceModeOn,
    startResizing,
    toggleDeviceMode: () => setIsDeviceModeOn((enabled) => !enabled),
    widthPercent,
  };
}
