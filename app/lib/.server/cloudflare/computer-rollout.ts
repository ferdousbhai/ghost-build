const COMPUTER_ROLLOUT_KEY = 'cloudflare_computer';

type ComputerRolloutRow = {
  mode: string;
  cohort_basis_points: number;
  cohort_salt: string;
};

type ComputerRolloutDecision = {
  enabled: boolean;
  mode: 'off' | 'cohort' | 'all' | 'invalid';
};

/** Resolve the mutable launch gate without logging or returning a user identifier. */
export async function resolveComputerRollout(db: D1Database, userId: string): Promise<ComputerRolloutDecision> {
  let row: ComputerRolloutRow | null;
  try {
    row = await db
      .prepare(
        `SELECT mode, cohort_basis_points, cohort_salt
         FROM launch_controls
         WHERE key = ?
         LIMIT 1`,
      )
      .bind(COMPUTER_ROLLOUT_KEY)
      .first<ComputerRolloutRow>();
  } catch {
    return { enabled: false, mode: 'invalid' };
  }
  if (!row) {
    return { enabled: false, mode: 'invalid' };
  }
  if (row.mode === 'off') {
    return { enabled: false, mode: 'off' };
  }
  if (row.mode === 'all') {
    return { enabled: true, mode: 'all' };
  }
  if (
    row.mode !== 'cohort' ||
    !Number.isSafeInteger(row.cohort_basis_points) ||
    row.cohort_basis_points < 0 ||
    row.cohort_basis_points > 10_000 ||
    !row.cohort_salt
  ) {
    return { enabled: false, mode: 'invalid' };
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${row.cohort_salt}\0${userId}`)),
  );
  const sample = new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getUint32(0, false);
  const normalizedSample = sample / 2 ** 32;
  return { enabled: normalizedSample < row.cohort_basis_points / 10_000, mode: 'cohort' };
}

export function computerRolloutUnavailableResponse(): Response {
  return Response.json(
    {
      code: 'computer_preview_unavailable',
      error: 'Cloudflare Computer beta access is temporarily unavailable. Please try again later.',
    },
    { status: 503, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '300' } },
  );
}
