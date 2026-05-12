import { ChatPane } from './ChatPane'
import { PreviewPane } from './PreviewPane'
import { Topbar } from './Topbar'
import { useBuilderSession } from './useBuilderSession'

export function BuilderApp() {
  const {
    canSubmit,
    checkResult,
    cloudflareStatus,
    codexAuthState,
    deployApproval,
    deployResult,
    generatedApp,
    hasCodexSignIn,
    hasStarted,
    isPending,
    messages,
    plan,
    preview,
    request,
    sessionSummaries,
    connectCloudflareToken,
    deployWorkerApp,
    generateWorkerApp,
    loadBuilderSession,
    prepareBuildPreview,
    requestDeployApproval,
    requestAgentPatch,
    repairGeneratedApp,
    runBuildDeployPipeline,
    runBuildPipeline,
    runBuildChecks,
    submitPrompt,
    updateIdea,
    updateGoalObjective,
    updateGoalSuccessCriteria,
    updateProjectSource,
    updateReasoningEffort,
  } = useBuilderSession()

  return (
    <main className="app-shell">
      <Topbar />

      <section className="builder">
        <ChatPane
          canSubmit={canSubmit}
          codexAuthState={codexAuthState}
          hasCodexSignIn={hasCodexSignIn}
          hasStarted={hasStarted}
          isPending={isPending}
          messages={messages}
          planReady={Boolean(plan)}
          prompt={request.idea}
          model={request.model}
          projectSource={request.projectSource}
          reasoningEffort={request.reasoningEffort}
          activeSessionId={plan?.deployment.sessionId}
          sessionSummaries={sessionSummaries}
          goal={request.goal}
          onPromptChange={updateIdea}
          onGoalObjectiveChange={updateGoalObjective}
          onGoalSuccessCriteriaChange={updateGoalSuccessCriteria}
          onProjectSourceChange={updateProjectSource}
          onReasoningEffortChange={updateReasoningEffort}
          onSelectSession={loadBuilderSession}
          onSubmit={submitPrompt}
        />

        <PreviewPane
          cloudflareStatus={cloudflareStatus}
          codexAuthState={codexAuthState}
          checkResult={checkResult}
          deployApproval={deployApproval}
          deployResult={deployResult}
          generatedApp={generatedApp}
          isPending={isPending}
          plan={plan}
          preview={preview}
          onConnectCloudflareToken={connectCloudflareToken}
          onDeployWorkerApp={deployWorkerApp}
          onGenerateWorkerApp={generateWorkerApp}
          onPrepareBuildPreview={prepareBuildPreview}
          onRequestAgentPatch={requestAgentPatch}
          onRequestDeployApproval={requestDeployApproval}
          onRepairGeneratedApp={repairGeneratedApp}
          onRunBuildDeployPipeline={runBuildDeployPipeline}
          onRunBuildPipeline={runBuildPipeline}
          onRunBuildChecks={runBuildChecks}
        />
      </section>
    </main>
  )
}
