import type { MapStore } from 'nanostores';
import type { ArtifactState } from './workbench-artifacts';
import { type PartId } from 'ghostbuild-agent/partId.js';

export type { PartId };

export type Artifacts = MapStore<Record<PartId, ArtifactState>>;
