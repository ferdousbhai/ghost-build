import { describe, expect, it } from 'vitest';
import { isComputerContainerCallback } from './container-fetch-routing';

describe('ProjectWorkspace container fetch routing', () => {
  it('reserves only /ws for the Computer callback', () => {
    expect(isComputerContainerCallback(new Request('https://workspace/ws'))).toBe(true);
    expect(isComputerContainerCallback(new Request('http://localhost:3000/rpc'))).toBe(false);
    expect(isComputerContainerCallback(new Request('https://workspace/'))).toBe(false);
  });
});
