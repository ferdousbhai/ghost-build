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
});
