import { describe, expect, it } from 'vitest';
import { ComputerAdmissionControl, ComputerOperationsDisabledError } from './computer-admission';

describe('ComputerAdmissionControl', () => {
  it('admits new operations while the operator control is enabled', async () => {
    const db = controlDatabase({ enabled: 1, reason: null });
    await expect(new ComputerAdmissionControl(db.binding).admitNewOperation()).resolves.toBeUndefined();
    expect(db.reads).toBe(1);
  });

  it('fails new operations closed with the operator reason once the switch is thrown', async () => {
    const db = controlDatabase({ enabled: 0, reason: 'Computer 0.1.1 container startup is failing.' });
    const admission = new ComputerAdmissionControl(db.binding);

    await expect(admission.admitNewOperation()).rejects.toMatchObject({
      code: 'computer_operations_disabled',
      message: '[computer_operations_disabled] Computer 0.1.1 container startup is failing.',
    });
    await expect(admission.admitNewOperation()).rejects.toBeInstanceOf(ComputerOperationsDisabledError);
  });

  it('re-reads the control without a redeploy once the decision window elapses', async () => {
    const db = controlDatabase({ enabled: 1, reason: null });
    const admission = new ComputerAdmissionControl(db.binding);
    await admission.admitNewOperation(0);
    await admission.admitNewOperation(9_999);
    expect(db.reads).toBe(1);

    db.control = { enabled: 0, reason: null };
    await expect(admission.admitNewOperation(10_000)).rejects.toBeInstanceOf(ComputerOperationsDisabledError);
    expect(db.reads).toBe(2);
  });

  it('admits new operations when no control row has ever been written', async () => {
    const db = controlDatabase(null);
    await expect(new ComputerAdmissionControl(db.binding).admitNewOperation()).resolves.toBeUndefined();
  });
});

function controlDatabase(control: { enabled: number; reason: string | null } | null) {
  const state = {
    control,
    reads: 0,
    binding: {} as D1Database,
  };
  state.binding = {
    prepare: (query: string) => {
      expect(query).toContain(`FROM runtime_controls WHERE key = 'computer_operations'`);
      return {
        first: async () => {
          state.reads += 1;
          return state.control;
        },
      };
    },
  } as unknown as D1Database;
  return state;
}
