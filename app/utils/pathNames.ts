export function slashPath(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function pathSegments(filePath: string) {
  return slashPath(filePath).split('/').filter(Boolean);
}
