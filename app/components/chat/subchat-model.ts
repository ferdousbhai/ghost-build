import type { SubchatSummary } from '~/lib/cloudflare/data-api';

export type { SubchatSummary };

export interface SubchatOption {
  label: string;
  value: number;
}

export function getSubchatLabel(subchatIndex: number, description?: string): string {
  const normalizedDescription = description?.trim();
  return normalizedDescription || (subchatIndex === 0 ? 'Initial chat' : `Feature #${subchatIndex}`);
}

export function createSubchatOptions(subchats: SubchatSummary[] | undefined): SubchatOption[] {
  return (
    subchats?.map((subchat) => ({
      label: getSubchatLabel(subchat.subchatIndex, subchat.description),
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
