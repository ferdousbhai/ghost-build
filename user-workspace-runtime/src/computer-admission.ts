const ADMISSION_DECISION_TTL_MS = 10_000;

const COMPUTER_OPERATIONS_DISABLED_ERROR_CODE = 'computer_operations_disabled';

export class ComputerOperationsDisabledError extends Error {
  readonly code = COMPUTER_OPERATIONS_DISABLED_ERROR_CODE;

  constructor(reason: string | null) {
    super(
      `[${COMPUTER_OPERATIONS_DISABLED_ERROR_CODE}] ${reason ?? 'New Computer-backed workspace operations are paused by the operator.'}`,
    );
    this.name = 'ComputerOperationsDisabledError';
  }
}

/**
 * Operator kill switch for the preview-only Computer runtime. Setting `enabled`
 * to 0 on the `computer_operations` row stops new Computer-backed operations
 * within one decision window and without a redeploy; durable project data stays
 * readable through the reads that never admit new work.
 *
 * Only that value pauses the runtime. Deleting the row admits everything again,
 * so an operator reaching for the switch has to write to it, not clear it.
 */
export class ComputerAdmissionControl {
  #nextReadAt = 0;
  #blocked: ComputerOperationsDisabledError | null = null;

  constructor(private readonly db: D1Database) {}

  async admitNewOperation(now = Date.now()): Promise<void> {
    if (now >= this.#nextReadAt) {
      const control = await this.db
        .prepare(`SELECT enabled, reason FROM runtime_controls WHERE key = 'computer_operations'`)
        .first<{ enabled: number; reason: string | null }>();
      this.#blocked = control?.enabled === 0 ? new ComputerOperationsDisabledError(control.reason) : null;
      this.#nextReadAt = now + ADMISSION_DECISION_TTL_MS;
    }
    if (this.#blocked) {
      throw this.#blocked;
    }
  }
}
