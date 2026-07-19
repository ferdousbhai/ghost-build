ALTER TABLE deployments
ADD COLUMN execution_generation INTEGER NOT NULL DEFAULT 0 CHECK (execution_generation >= 0);

-- During a rolling deployment, the previous Worker may approve a deployment
-- without incrementing the new execution_generation column. Preserve the
-- monotonic generation contract for both first approvals and reapprovals. The
-- new Worker increments in its own UPDATE, so this trigger deliberately no-ops
-- when the generation already changed.
CREATE TRIGGER trg_deployments_legacy_approval_execution_generation
AFTER UPDATE OF status ON deployments
WHEN OLD.status = 'awaiting_approval'
  AND NEW.status = 'approved'
  AND NEW.execution_generation = OLD.execution_generation
BEGIN
  UPDATE deployments
  SET execution_generation = OLD.execution_generation + 1
  WHERE id = NEW.id
    AND status = 'approved'
    AND execution_generation = OLD.execution_generation;
END;

-- Existing rows that crossed approval belong to their first immutable
-- execution generation. Rows never approved remain at zero until approval.
UPDATE deployments
SET execution_generation = 1
WHERE approved_at IS NOT NULL;
