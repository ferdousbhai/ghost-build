type Debounced<Args extends unknown[]> = ((...args: Args) => void) & {
  cancel: () => void;
};

export function debounce<Args extends unknown[]>(func: (...args: Args) => unknown, wait: number): Debounced<Args> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const debounced = function executedFunction(...args: Args) {
    const later = () => {
      timeout = undefined;
      func(...args);
    };

    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };

  debounced.cancel = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  return debounced;
}
