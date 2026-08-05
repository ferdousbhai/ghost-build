export function isComputerContainerCallback(request: Request): boolean {
  return new URL(request.url).pathname === '/ws';
}
