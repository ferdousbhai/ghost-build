import { atom } from 'nanostores';
import {
  idleBuilderPreviewState,
  type BuilderPreviewMode,
  type BuilderPreviewState,
} from '~/agents/builder-preview-types';

type PreviewActions = {
  request(mode: BuilderPreviewMode): Promise<BuilderPreviewState>;
};

export class PreviewsStore {
  state = atom<BuilderPreviewState>(idleBuilderPreviewState(0));
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

  request(mode: BuilderPreviewMode = 'production'): Promise<BuilderPreviewState> {
    return this.#requireActions().request(mode);
  }

  #requireActions(): PreviewActions {
    if (!this.#actions) {
      throw new Error('The remote preview connection is not ready.');
    }
    return this.#actions;
  }
}
