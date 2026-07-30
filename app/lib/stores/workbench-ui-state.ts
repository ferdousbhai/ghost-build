import { atom } from 'nanostores';

export type WorkbenchViewType = 'code' | 'preview';

export const workbenchCurrentView = import.meta.hot?.data.workbenchCurrentView ?? atom<WorkbenchViewType>('code');

if (import.meta.hot) {
  import.meta.hot.data.workbenchCurrentView = workbenchCurrentView;
}
