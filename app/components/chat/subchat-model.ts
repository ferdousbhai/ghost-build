export interface SubchatSummary {
  subchatIndex: number;
  updatedAt: number;
  description?: string;
}

export interface SubchatOption {
  label: string;
  value: number;
}

export function createSubchatOptions(subchats: SubchatSummary[] | undefined): SubchatOption[] {
  return (
    subchats?.map((subchat, arrayIndex) => ({
      label: subchat.description || (arrayIndex === 0 ? 'Initial chat' : `Feature #${arrayIndex}`),
      value: subchat.subchatIndex,
    })) ?? []
  );
}

export function getSubchatNavigation(subchatCount: number, currentSubchatIndex: number, hasSession: boolean) {
  const latestSubchatIndex = subchatCount - 1;
  const hasMultipleSubchats = subchatCount > 1;
  return {
    canCreateSubchat: currentSubchatIndex >= latestSubchatIndex && hasSession,
    canNavigateNext: hasMultipleSubchats && currentSubchatIndex < latestSubchatIndex,
    canNavigatePrev: hasMultipleSubchats && currentSubchatIndex > 0,
    hasMultipleSubchats,
    latestSubchatIndex,
  };
}
