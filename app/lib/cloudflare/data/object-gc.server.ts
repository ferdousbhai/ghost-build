export const OBJECT_GC_GRACE_PERIOD_MS = 5 * 60 * 1000;
export const DEPLOYMENT_BUILD_ARTIFACT_LEASE_MS = 65 * 60 * 1000;

export function prepareObjectGcCandidateStatements(
  db: D1Database,
  keys: Array<string | null>,
  now = Date.now(),
): D1PreparedStatement[] {
  const notBefore = now + OBJECT_GC_GRACE_PERIOD_MS;
  return [...new Set(keys.filter((key): key is string => Boolean(key)))].map((key) =>
    db
      .prepare(
        `INSERT INTO object_gc_candidates (storage_key, not_before, created_at, attempts)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(storage_key) DO UPDATE SET
           not_before = MAX(object_gc_candidates.not_before, excluded.not_before)`,
      )
      .bind(key, notBefore, now),
  );
}
