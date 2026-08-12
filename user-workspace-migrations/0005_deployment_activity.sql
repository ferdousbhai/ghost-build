CREATE TABLE deployment_activity (
  deployment_id TEXT NOT NULL,
  execution_generation INTEGER NOT NULL CHECK (execution_generation > 0),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (deployment_id, execution_generation, sequence),
  FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
);

CREATE INDEX idx_deployment_activity_current
ON deployment_activity(deployment_id, execution_generation, sequence);
