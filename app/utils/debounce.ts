export function debounce<Args extends unknown[]>(
  func: (...args: Args) => unknown,
  wait: number,
): (...args: Args) => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  return function executedFunction(...args: Args) {
    const later = () => {
      timeout = undefined;
      func(...args);
    };

    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(later, wait);
  };
}
