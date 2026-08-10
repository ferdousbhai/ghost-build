import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('BuilderAgent preview lifecycle', () => {
  const source = readFileSync(new URL('./builder-agent.ts', import.meta.url), 'utf8');

  it('cancels background preview work before a foreground user turn', () => {
    const chatMessage = source.slice(
      source.indexOf('override async onChatMessage('),
      source.indexOf('private async runContextCompaction('),
    );

    expect(chatMessage).toContain('if (!options?.continuation) {\n      await this.cancelPreview();\n    }');
  });

  it('automatically previews only an exactly validated durable revision', () => {
    const response = source.slice(
      source.indexOf('protected override async onChatResponse('),
      source.indexOf('@callable()\n  getTurnHistory'),
    );
    const preview = source.slice(
      source.indexOf('private async requestPreviewInternal('),
      source.indexOf('private async runPreviewBuild('),
    );

    expect(response).toContain('this.requestPreviewInternal({ requireValidation: true })');
    expect(preview).toContain(
      'options.requireValidation && !(await this.workspace.hasSuccessfulValidation(snapshot.revision))',
    );
  });

  it('persists requested runtime compaction only after the completed response', () => {
    const chatMessage = source.slice(
      source.indexOf('override async onChatMessage('),
      source.indexOf('private async scheduleContextCompaction('),
    );
    const response = source.slice(
      source.indexOf('protected override async onChatResponse('),
      source.indexOf('@callable()\n  getTurnHistory'),
    );

    expect(chatMessage).toContain('requestDurableCompaction: () =>');
    expect(response).toContain('const compactAfterTurn =');
    expect(response).toContain('this.scheduleContextCompaction(throughMessageId, this.messages.length, credentials)');
    expect(response.indexOf('await this.advanceTranscriptCheckpoint')).toBeLessThan(
      response.indexOf('this.scheduleContextCompaction'),
    );
  });

  it('keeps the agent alive while stateful Computer tools run', () => {
    const chatMessage = source.slice(
      source.indexOf('override async onChatMessage('),
      source.indexOf('private async runContextCompaction('),
    );

    expect(chatMessage).toContain('runWithKeepAlive: (operation) => this.keepAliveWhile(operation)');
  });

  it('cancels active validation before waiting for a stopped turn to settle', () => {
    const cancellation = source.slice(
      source.indexOf('async cancelActiveTurn()'),
      source.indexOf('@callable()\n  getWorkspaceState'),
    );
    const boundedCancellation = 'await waitForCancellationBeforeDeadline(validationCancellation, deadline)';

    expect(cancellation).toContain('const validationCancellation = this.workspace.cancelActiveValidation()');
    expect(cancellation.indexOf('this.abortAllRequests(')).toBeLessThan(cancellation.indexOf(boundedCancellation));
    expect(cancellation.indexOf(boundedCancellation)).toBeLessThan(cancellation.indexOf('await this.waitUntilStable('));
    expect(cancellation).toContain('const deadline = Date.now() + CHAT_CANCELLATION_SETTLE_TIMEOUT_MS');
    expect(cancellation).toContain('const remainingSettleTime = Math.max(0, deadline - Date.now())');
    expect(cancellation).toContain('timeout: remainingSettleTime');
  });
});
