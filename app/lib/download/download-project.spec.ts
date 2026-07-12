import { describe, expect, it } from 'vitest';
import { projectFileName } from './download-project';

describe('projectFileName', () => {
  it('normalizes the project description for downloads', () => {
    expect(projectFileName('My Ghost App')).toBe('my_ghost_app');
    expect(projectFileName('')).toBe('project');
  });
});
