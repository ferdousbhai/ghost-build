import { atom } from 'nanostores';
import type { ActionAlert } from '~/types/actions';

export type WorkbenchViewType = 'code' | 'preview';

export const workbenchCurrentView = import.meta.hot?.data.workbenchCurrentView ?? atom<WorkbenchViewType>('code');
export const workbenchActionAlert =
  import.meta.hot?.data.workbenchActionAlert ?? atom<ActionAlert | undefined>(undefined);

if (import.meta.hot) {
  import.meta.hot.data.workbenchCurrentView = workbenchCurrentView;
  import.meta.hot.data.workbenchActionAlert = workbenchActionAlert;
}
