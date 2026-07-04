import { useState, useEffect } from 'react';

const useViewport = (threshold = 1024) => {
  const [isSmallViewport, setIsSmallViewport] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth < threshold,
  );

  useEffect(() => {
    const handleResize = () => setIsSmallViewport(window.innerWidth < threshold);
    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [threshold]);

  return isSmallViewport;
};

export default useViewport;
