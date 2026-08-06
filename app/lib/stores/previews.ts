import { atom, computed } from 'nanostores';
import { idleBuilderPreviewState, type BuilderPreviewState } from '~/agents/builder-preview-types';

type PreviewActions = {
  request(): Promise<BuilderPreviewState>;
};

export class PreviewsStore {
  state = atom<BuilderPreviewState>(idleBuilderPreviewState(0));
  hasPreview = computed(this.state, (state) => Boolean(state.active ?? state.lastSuccessful));
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

  reset(): void {
    this.#actions = null;
    this.state.set(idleBuilderPreviewState(0));
  }

  request(): Promise<BuilderPreviewState> {
    return this.#requireActions().request();
  }

  #requireActions(): PreviewActions {
    if (!this.#actions) {
      throw new Error('The remote preview connection is not ready.');
    }
    return this.#actions;
  }
}
