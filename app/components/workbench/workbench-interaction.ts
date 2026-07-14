type WorkbenchInteraction = {
  heavyContentEnabled: boolean;
  hiddenContentInert: boolean;
  safeViewControlsEnabled: boolean;
  editorEditable: boolean;
};

export function getWorkbenchInteraction(args: { visible: boolean; isStreaming: boolean }): WorkbenchInteraction {
  return {
    heavyContentEnabled: args.visible && !args.isStreaming,
    hiddenContentInert: !args.visible,
    safeViewControlsEnabled: true,
    editorEditable: !args.isStreaming,
  };
}
