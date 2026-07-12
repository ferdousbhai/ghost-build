import { describe, expect, it } from 'vitest';
import { isHiddenAssistantPart } from './assistant-message-parts';

describe('isHiddenAssistantPart', () => {
  it('hides internal assistant parts that are not user-facing', () => {
    expect(isHiddenAssistantPart({ type: 'step-start' })).toBe(true);
    expect(isHiddenAssistantPart({ type: 'reasoning' })).toBe(true);
  });

  it('does not hide renderable text parts', () => {
    expect(isHiddenAssistantPart({ type: 'text' })).toBe(false);
  });
});
