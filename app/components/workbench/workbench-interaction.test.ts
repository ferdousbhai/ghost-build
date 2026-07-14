import { describe, expect, it } from 'vitest';
import { getWorkbenchInteraction } from './workbench-interaction';

describe('getWorkbenchInteraction', () => {
  it('keeps safe viewing controls responsive during generation', () => {
    expect(getWorkbenchInteraction({ visible: true, isStreaming: true })).toEqual({
      heavyContentEnabled: false,
      hiddenContentInert: false,
      safeViewControlsEnabled: true,
      editorEditable: false,
    });
  });

  it('prevents a closed off-screen workbench from intercepting clicks', () => {
    expect(getWorkbenchInteraction({ visible: false, isStreaming: true })).toMatchObject({
      heavyContentEnabled: false,
      hiddenContentInert: true,
      safeViewControlsEnabled: true,
    });
  });

  it('mounts the editor and preview after generation finishes', () => {
    expect(getWorkbenchInteraction({ visible: true, isStreaming: false })).toEqual({
      heavyContentEnabled: true,
      hiddenContentInert: false,
      safeViewControlsEnabled: true,
      editorEditable: true,
    });
  });
});
