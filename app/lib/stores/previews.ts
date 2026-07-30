import { atom, computed } from 'nanostores';
import { idleBuilderPreviewState, type BuilderPreviewState } from '~/agents/builder-preview-types';

export interface PreviewInfo {
  id: string;
  ready: boolean;
  baseUrl: string;
  workspaceRevision: number;
}

type PreviewActions = {
  refresh(): Promise<BuilderPreviewState>;
  request(): Promise<BuilderPreviewState>;
  cancel(): Promise<BuilderPreviewState>;
};

export class PreviewsStore {
  state = atom<BuilderPreviewState>(idleBuilderPreviewState(0));
  previews = computed(this.state, (state): PreviewInfo[] => {
    const preview = state.active ?? state.lastSuccessful;
    return preview
      ? [
          {
            id: preview.id,
            ready: state.status === 'ready' && !state.stale,
            baseUrl: preview.url,
            workspaceRevision: preview.workspaceRevision,
          },
        ]
      : [];
  });
  #actions: PreviewActions | null = null;

  connect(actions: PreviewActions): () => void {
    this.#actions = actions;
    return () => {
      if (this.#actions === actions) {
        this.#actions = null;
      }
    };
  }

  update(state: BuilderPreviewState): void {
    this.state.set(state);
  }

  refresh(): Promise<BuilderPreviewState> {
    return this.#requireActions().refresh();
  }

  request(): Promise<BuilderPreviewState> {
    return this.#requireActions().request();
  }

  cancel(): Promise<BuilderPreviewState> {
    return this.#requireActions().cancel();
  }

  #requireActions(): PreviewActions {
    if (!this.#actions) {
      throw new Error('The remote preview connection is not ready.');
    }
    return this.#actions;
  }
}
