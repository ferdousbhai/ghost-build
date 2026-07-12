import type { WebContainer } from '@webcontainer/api';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { runDeploy } from './deploy';
import { isFileTool, runFileTool } from './file-tools';
import { runLookupDocs } from './lookup-docs';
import { runNpmInstall } from './npm-install';
import type { ActionRunnerWorkspace } from './types';

export async function executeTool(args: {
  invocation: GhostbuildToolInvocation;
  container: WebContainer;
  abortSignal: AbortSignal;
  onOutput: (output: string) => void;
  workspace: ActionRunnerWorkspace;
}): Promise<string> {
  if (isFileTool(args.invocation.toolName)) {
    return runFileTool(args.invocation, args.container, args.workspace);
  }

  switch (args.invocation.toolName) {
    case 'npmInstall':
      return runNpmInstall(args);
    case 'lookupDocs':
      return runLookupDocs(args.invocation);
    case 'deploy':
      return runDeploy(args);
    default:
      throw new Error(`Unknown tool: ${args.invocation.toolName}`);
  }
}
