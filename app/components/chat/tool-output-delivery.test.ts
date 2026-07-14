import { describe, expect, it, vi } from 'vitest';
import { deliverToolOutput } from './tool-output-delivery';

describe('deliverToolOutput', () => {
  it('delivers a tool result so automatic continuation can proceed', () => {
    const deliver = vi.fn();
    const onFailure = vi.fn();
    const output = { toolCallId: 'call', output: 'saved' };

    expect(deliverToolOutput({ deliver, output, onFailure })).toBe(true);
    expect(deliver).toHaveBeenCalledWith(output);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('turns a continuation handoff failure into an explicit failure callback', () => {
    const error = new Error('socket closed');
    const onFailure = vi.fn();

    expect(
      deliverToolOutput({
        deliver: () => {
          throw error;
        },
        output: { toolCallId: 'call', output: 'saved' },
        onFailure,
      }),
    ).toBe(false);
    expect(onFailure).toHaveBeenCalledWith(error);
  });
});
