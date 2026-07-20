import type { WebContainer } from '@webcontainer/api';
import type { GhostbuildToolInvocation } from 'ghostbuild-agent/ai-compat';
import { runDeploy } from './deploy';
import { isFileTool, runFileTool } from './file-tools';
import { runLookupDocs } from './lookup-docs';
import { runNpmInstall } from './npm-install';
import type { ActionRunnerWorkspace } from './types';
import { getDiagnosticsParameters } from 'ghostbuild-agent/tools/getDiagnostics';
import { runListFiles, runSearchText } from './project-navigation';
import { toolSuccess, type GhostbuildToolResult } from 'ghostbuild-agent/tool-result';
import { runValidateProject } from './validate-project';
import type { DiagnosticsStore } from './diagnostics-store';
import { pageCoverage } from './bounded-pagination';
import type { DeploymentValidationStore } from './deployment-validation-store';

export async function executeTool(args: {
  invocation: GhostbuildToolInvocation;
  container: WebContainer;
  abortSignal: AbortSignal;
  onOutput: (output: string) => void;
  workspace: ActionRunnerWorkspace;
  diagnostics: DiagnosticsStore;
  deploymentValidation: DeploymentValidationStore;
}): Promise<GhostbuildToolResult> {
  if (isFileTool(args.invocation.toolName)) {
    return runFileTool(args.invocation, args.container, args.workspace);
  }

  switch (args.invocation.toolName) {
    case 'listFiles':
      return runListFiles({
        input: args.invocation.args,
        files: args.workspace.getFiles(),
        abortSignal: args.abortSignal,
      });
    case 'searchText':
      return runSearchText({
        input: args.invocation.args,
        files: args.workspace.getFiles(),
        recentFileWrites: args.workspace.getRecentFileWrites?.(),
        abortSignal: args.abortSignal,
      });
    case 'getDiagnostics': {
      const input = getDiagnosticsParameters.parse(args.invocation.args);
      const { label, page } = args.diagnostics.read(input.diagnosticsId, input.cursor);
      const nextCursor = page.complete ? undefined : String(page.end);
      return toolSuccess(
        `Returned diagnostics ${page.start}-${page.end} of ${page.total} from ${label}.`,
        { diagnosticsId: input.diagnosticsId, records: page.items },
        pageCoverage(page, nextCursor),
      );
    }
    case 'validateProject':
      return runValidateProject(args);
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
