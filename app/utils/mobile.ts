const TAILWIND_SM_BREAKPOINT_PX = 640;

export function isMobile() {
  return globalThis.innerWidth < TAILWIND_SM_BREAKPOINT_PX;
}
