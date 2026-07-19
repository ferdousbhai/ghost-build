ALTER TABLE deployments
ADD COLUMN build_artifact_key TEXT;

ALTER TABLE deployments
ADD COLUMN build_artifact_generation INTEGER CHECK (
  build_artifact_generation IS NULL OR build_artifact_generation >= 1
);
