interface DirEnt<T> {
  name: T;
  isDirectory(): boolean;
}

export function renderDirectory(children: DirEnt<string>[]) {
  return `Directory:\n${children.map((child) => `- ${child.name} (${child.isDirectory() ? 'dir' : 'file'})`).join('\n')}`;
}
