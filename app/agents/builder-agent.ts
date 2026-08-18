import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryExhaustedContext,
  type ChatRecoveryOptions,
  type ChatResponseResult,
} from '@cloudflare/ai-chat';
import { callable, type FiberRecoveryContext, type FiberRecoveryResult } from 'agents';
import { canApplyConversationCompaction, conversationCompactionKey } from '~/lib/compaction';
import { createChatResponseFromBody, type ChatRequestBody } from '~/lib/.server/chat';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import {
  completeBuilderTurn,
  createBuilderTurn,
  createRecoveryTurn,
  exhaustedBuilderTurnResult,
  recordBuilderTurnBudget,
  type BuilderTurnState,
  type BuilderTurnStatus,
} from './builder-turn-state';
import type { BuilderTurnBudgetReport } from '~/lib/.server/llm/builder-turn-budget';
import { DurableObjectContextCompactionRepository } from '~/lib/.server/llm/context-compaction-store';
import { compactContext } from '~/lib/.server/llm/context-compaction';
import { summarizeBuilderContext } from '~/lib/.server/llm/workers-ai-text';
import { chatTurnContextSchema, type ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { getUserWorkersAiCredentials } from '~/lib/.server/cloudflare/workers-ai-billing-context';
import type { UIMessage } from 'ai';
import {
  deployValidatedRevisionForBuilder,
  terminalizeInterruptedDeploymentForBuilder,
  validatedDeploymentCheckpoint,
  type BuilderDeploymentState,
} from './builder-deployment-command';
import { generateConversationTitle, generateProjectTitle } from '~/lib/.server/llm/workers-ai-title';
import {
  setGeneratedProjectDescription,
  setGeneratedSubchatDescription,
  setHeuristicProjectDescriptionIfMissing,
  setHeuristicSubchatDescriptionIfMissing,
} from '~/lib/cloudflare/data/chat-service.server';
import { messageText } from 'ghostbuild-agent/ai-compat';
import {
  transcriptCheckpointSchema,
  transcriptCheckpointsEqual,
  transcriptMessagesEqual,
  stripTranscriptBaseMetadata,
  advanceTranscriptCheckpoint,
  TRANSCRIPT_BASE_METADATA_KEY,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
} from 'ghostbuild-agent/transcript';
import { createWorkersAiSessionAffinity } from '~/lib/.server/llm/workers-ai-prompt-cache';
import {
  boundBuilderMessageForPersistence,
  loadBuilderTranscriptBinding,
  requireBuilderRequestScope,
  requireBuilderTranscriptIdentity,
  type BuilderTranscriptBinding,
} from './builder-request-policy';
import { initializeBuilderAgentSchema } from './builder-agent-schema';
import {
  BuilderAgentIdentityMismatchError,
  BuilderAgentIdentityRepository,
  builderAgentIdentitiesEqual,
  type BuilderAgentDurableIdentity,
} from './builder-agent-identity';
import type { BuilderWorkspaceApi, BuilderWorkspaceCheckpoint } from './builder-workspace-api';
import { UserWorkspaceRuntimeClient } from '~/lib/.server/cloudflare/user-workspace-runtime-client';
import type {
  BuilderWorkspaceFileInput,
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from './builder-workspace-types';
import { builderTemplateSeedId, loadBuilderTemplate } from './builder-template';
import { parentBuilderWorkspaceSeedId, seedBuilderWorkspace } from './builder-workspace-seed';
import { deriveProvisionalTitle, shouldGenerateConversationTitle } from '~/lib/title-generation';
import {
  failedBuilderPreviewState,
  idleBuilderPreviewState,
  previewStateForWorkspace,
  type BuilderPreviewState,
} from './builder-preview-types';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { waitForCancellationBeforeDeadline } from './builder-cancellation';
import { PiSteeringQueue } from '~/lib/.server/llm/pi-steering';
import { MAX_USER_MESSAGE_CHARACTERS } from 'ghostbuild-agent/context-limits';

const logger = createScopedLogger('BuilderAgent');
const CONTEXT_COMPACTION_FIBER = 'background:context_compaction';
const PREVIEW_BUILD_FIBER = 'background:builder_preview';
const DEPLOYMENT_FIBER = 'background:builder_deployment';
const TITLE_GENERATION_FIBER = 'background:title_generation';
const TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS = 4_000;
const CHAT_CANCELLATION_SETTLE_TIMEOUT_MS = 4.5 * 60 * 1000;

type PreviewBuildJob = {
  previewId: string;
  workspaceRevision: number;
  snapshotRevision: string;
  requestedAt: number;
};

type DeploymentJob = BuilderWorkspaceCheckpoint;

type TitleGenerationJob = {
  chatInitialId: string;
  firstPrompt: boolean;
  prompt: string;
  promptGeneration: number;
  subchatIndex: number;
};

export type BuilderAgentState = {
  activeTurn?: BuilderTurnState | null;
  generatedSubchatTitle?: {
    subchatIndex: number;
    title: string;
    updatedAt: string;
  } | null;
  lastCompletedTurn?: BuilderTurnState | null;
  updatedAt?: string;
  transcript?: TranscriptCheckpoint | null;
  preview?: BuilderPreviewState | null;
  validationProgress?: {
    toolCallId: string;
    stage: BuilderValidationStage;
    updatedAt: string;
  } | null;
  deployment?: BuilderDeploymentState | null;
  contextCompactionRequestedTurnId?: string | null;
};

export type BuilderSteeringInput = {
  text: string;
  turnContext?: ChatTurnContext;
};

type ChatBody = Partial<ChatRequestBody> & { transcript?: unknown };

type BuilderAgentProps = {
  ownerId: string;
  userId: string;
};

export class BuilderAgent extends AIChatAgent<Env, BuilderAgentState, BuilderAgentProps> {
  static override options = {
    sendIdentityOnConnect: false,
  };

  initialState: BuilderAgentState = {
    activeTurn: null,
    generatedSubchatTitle: null,
    lastCompletedTurn: null,
    transcript: null,
    preview: idleBuilderPreviewState(0),
    validationProgress: null,
    deployment: null,
    contextCompactionRequestedTurnId: null,
  };

  override chatRecovery = {
    terminalMessage: 'The builder was interrupted. Please send your message again.',
    onExhausted: (context: ChatRecoveryExhaustedContext) => {
      const activeTurn = this.state.activeTurn;
      if (!activeTurn) {
        return;
      }
      const result = exhaustedBuilderTurnResult(activeTurn, context);
      if (result) {
        this.finishTurn(activeTurn, result);
      }
    },
  };

  private readonly contextCompaction = new DurableObjectContextCompactionRepository(this);
  private readonly identityRepository: BuilderAgentIdentityRepository;
  private readonly workspace: BuilderWorkspaceApi;
  private ownerId: string | null = null;
  private userId: string | null = null;
  private transcriptBinding: BuilderTranscriptBinding | null = null;
  private activeSteering: { turnId: string; queue: PiSteeringQueue } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeBuilderAgentSchema(ctx);
    this.identityRepository = new BuilderAgentIdentityRepository(ctx.storage);
    this.workspace = new UserWorkspaceRuntimeClient(env, ctx.id.toString(), () => this.userId);
  }

  async onStart(props?: BuilderAgentProps) {
    if (props) {
      await this.initializeIdentity(props);
      return;
    }
    await this.hydrateDurableIdentity({ required: false, reason: 'agent_start' });
  }

  /**
   * Accept durable deletion without making the caller wait for the
   * abort-shaped `destroy()` RPC. This is intentionally not decorated with
   * `@callable`: it is an internal Durable Object RPC used only by the D1 GC
   * outbox.
   */
  async scheduleDestroyForGc(ownerId: string): Promise<void> {
    await this.initializeGcIdentity(ownerId);
    const previewId = this.state.preview?.pendingId ?? this.state.preview?.active?.id;
    if (previewId) {
      await this.cancelFiberByKey(this.previewFiberKey(previewId), 'Project deletion').catch(() => undefined);
      await this.workspace.stopPreview(previewId).catch(() => undefined);
    }
    await this.workspace.deleteProject();
    await this._cf_scheduleDestroy();
  }

  private async initializeGcIdentity(ownerId: string): Promise<void> {
    if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 512) {
      throw new Response('Invalid transcript owner', { status: 400 });
    }
    if (this.ownerId && this.ownerId !== ownerId) {
      throw new Response('Agent not found.', { status: 404 });
    }
    const owned = await this.env.DB.prepare(
      `SELECT 1 AS found
       FROM chat_transcripts AS transcripts
       INNER JOIN chats ON chats.id = transcripts.chat_id
       WHERE transcripts.agent_name = ? AND chats.creator_id = ?
       LIMIT 1`,
    )
      .bind(this.name, ownerId)
      .first<{ found: number }>();
    if (!owned) {
      throw new Response('Agent not found.', { status: 404 });
    }
    this.ownerId = ownerId;
    this.userId = ownerId;
  }

  override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    await this.hydrateDurableIdentity({ required: true, reason: 'chat_recovery', incidentId: ctx.incidentId });
    if (this.state.transcript) {
      await this.advanceTranscriptCheckpoint(this.state.transcript);
    }
    const lastTurn = this.state.lastCompletedTurn;
    if (
      !this.state.activeTurn &&
      lastTurn?.status === 'aborted' &&
      (lastTurn.requestId === ctx.requestId || lastTurn.requestId === ctx.recoveryRootRequestId)
    ) {
      logger.info('Skipping recovery for a durably cancelled Ghostbuild chat turn', {
        incidentId: ctx.incidentId,
      });
      return { persist: true, continue: false };
    }
    const nextTurn = createRecoveryTurn(ctx, this.state.activeTurn);
    this.setState({
      ...this.state,
      activeTurn: nextTurn,
      updatedAt: nextTurn.updatedAt,
    });
    logger.warn('Recovering interrupted Ghostbuild chat turn', {
      incidentId: nextTurn.recovery?.incidentId,
      recoveryKind: ctx.recoveryKind,
      attempt: ctx.attempt,
      hasPartialOutput: ctx.partialText.length > 0,
      hasRecoveryData: ctx.recoveryData !== undefined,
    });

    return {};
  }

  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    await this.hydrateDurableIdentity({
      required: true,
      reason: 'fiber_recovery',
      incidentId: typeof ctx.id === 'string' ? ctx.id : undefined,
    });
    if (ctx.name === TITLE_GENERATION_FIBER) {
      const job = parseTitleGenerationJob(ctx.metadata);
      if (!job || !this.userId) {
        return { status: 'error', error: 'missing title generation recovery data' };
      }
      const credentials = await getUserWorkersAiCredentials(this.env, this.userId);
      await this.generateTitlesForPrompt({ ...job, accountCredentials: credentials });
      return { status: 'completed', snapshot: ctx.snapshot };
    }
    if (ctx.name === PREVIEW_BUILD_FIBER) {
      const job = parsePreviewBuildJob(ctx.metadata);
      if (!job) {
        return { status: 'error', error: 'missing preview build recovery data' };
      }
      await this.runPreviewBuild(job);
      return { status: 'completed', snapshot: ctx.snapshot };
    }
    if (ctx.name === DEPLOYMENT_FIBER) {
      const job = parseDeploymentJob(ctx.metadata);
      if (!job || !this.userId || !this.transcriptBinding) {
        return { status: 'error', error: 'missing deployment recovery data' };
      }
      const error = new Error('Deployment was interrupted. Retry to reconcile the exact revision.');
      try {
        await this.retry(() => this.terminalizeDeployment(job));
      } catch (recoveryError) {
        logger.error('Unable to terminalize the interrupted deployment', recoveryError);
        this.failDeployment(job, new Error('Interrupted deployment recovery is pending. Retry to continue.'));
        return { status: 'error', error: 'Interrupted deployment recovery did not settle safely.' };
      }
      this.failDeployment(job, error);
      return { status: 'error', error: error.message };
    }
    if (ctx.name !== CONTEXT_COMPACTION_FIBER) {
      return super.onFiberRecovered(ctx);
    }
    const throughMessageId = typeof ctx.metadata?.throughMessageId === 'string' ? ctx.metadata.throughMessageId : null;
    if (!throughMessageId || !this.userId) {
      return { status: 'error', error: 'missing context compaction recovery data' };
    }
    const credentials = await getUserWorkersAiCredentials(this.env, this.userId);
    await this.runContextCompaction(throughMessageId, credentials);
    return { status: 'completed', snapshot: ctx.snapshot };
  }

  override async onChatMessage(
    _onFinish?: unknown,
    options?: { requestId?: string; body?: Record<string, unknown>; continuation?: boolean; abortSignal?: AbortSignal },
  ) {
    const durableIdentity = await this.hydrateDurableIdentity({ required: true, reason: 'chat_message' });
    if (!durableIdentity) {
      this.rejectIdentity('chat_message_missing', undefined, 401);
    }
    const body = (options?.body ?? {}) as ChatBody;
    const messages = this.messages as NonNullable<ChatRequestBody['messages']>;
    const { chatInitialId, subchatIndex, transcript, modelId } = requireBuilderRequestScope(
      body,
      durableIdentity.transcript,
    );
    if (!options?.continuation) {
      await this.cancelPreview();
    }
    await this.advanceTranscriptCheckpoint(transcript);
    this.contextCompaction.migrateLegacySubchat(subchatIndex);
    const turnContext = parseTurnContext(body.turnContext);
    const userMessages = messages.filter((message: { role?: string }) => message.role === 'user');
    const firstUserMessage = !options?.continuation && userMessages.length === 1;
    const latestPrompt = !options?.continuation ? userMessages.at(-1) : undefined;
    const latestPromptText = latestPrompt ? messageText(latestPrompt) : '';
    const shouldGenerateTitle = shouldGenerateConversationTitle(latestPromptText, userMessages.length);
    const turn = createBuilderTurn({
      requestId: options?.requestId,
      chatInitialId,
      continuation: options?.continuation === true,
      firstUserMessage,
      messages,
    });
    console.info({
      event: 'builder_chat_turn_started',
      continuation: options?.continuation === true,
      firstUserMessage,
    });
    this.setState({
      ...this.state,
      activeTurn: turn,
      updatedAt: turn.updatedAt,
    });
    const steering = new PiSteeringQueue();
    this.activeSteering = { turnId: turn.id, queue: steering };
    const settleSteering = () => {
      if (this.activeSteering?.turnId === turn.id) {
        this.activeSteering = null;
      }
    };

    try {
      const accountCredentials = await getUserWorkersAiCredentials(this.env, durableIdentity.userId);
      if (shouldGenerateTitle) {
        await this.scheduleTitleGeneration(
          {
            chatInitialId,
            firstPrompt: firstUserMessage,
            prompt: latestPromptText.slice(0, TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS),
            promptGeneration: userMessages.length,
            subchatIndex,
          },
          accountCredentials,
        );
      }
      this.stashTurn(turn);
      const compactionPending = await this.hasPendingContextCompaction();
      return await createChatResponseFromBody({
        abortSignal: options?.abortSignal,
        firstUserMessage,
        turnContext,
        accountCredentials,
        sessionAffinity: await createWorkersAiSessionAffinity(transcript, modelId),
        workspace: this.workspace,
        onValidationStage: (toolCallId, stage) => this.setValidationProgress(toolCallId, stage),
        runWithKeepAlive: (operation) => this.keepAliveWhile(operation),
        steering,
        onSettled: (budget) => {
          settleSteering();
          this.recordTurnBudget(turn.id, budget);
        },
        compaction: {
          current: this.contextCompaction.getCompaction(),
          pending: compactionPending,
          summarize: (prompt, signal) => summarizeBuilderContext(prompt, accountCredentials, signal),
          save: (compaction) => this.contextCompaction.saveCompaction(compaction),
          schedule: async () => {
            const throughMessageId = messages.at(-1)?.id;
            if (throughMessageId) {
              await this.scheduleContextCompaction(throughMessageId, messages.length, accountCredentials);
            }
          },
          requestDurableCompaction: () => {
            if (this.state.activeTurn?.id === turn.id && this.state.contextCompactionRequestedTurnId !== turn.id) {
              this.setState({
                ...this.state,
                contextCompactionRequestedTurnId: turn.id,
                updatedAt: new Date().toISOString(),
              });
            }
          },
        },
        body: { messages, modelId },
      });
    } catch (error) {
      steering.close();
      settleSteering();
      this.finishTurn(turn, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async scheduleContextCompaction(
    throughMessageId: string,
    revision: number,
    accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>,
  ): Promise<void> {
    if (await this.hasPendingContextCompaction()) {
      return;
    }
    await this.startFiber(
      CONTEXT_COMPACTION_FIBER,
      async (fiber) => {
        fiber.stash({ throughMessageId, version: 1 });
        await this.runContextCompaction(throughMessageId, accountCredentials);
      },
      {
        idempotencyKey: conversationCompactionKey({
          scope: this.name,
          throughId: throughMessageId,
          revision,
        }),
        metadata: { throughMessageId },
      },
    );
  }

  private async runContextCompaction(
    throughMessageId: string,
    accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>,
  ): Promise<void> {
    const currentMessages = this.messages as NonNullable<ChatRequestBody['messages']>;
    const throughIndex = currentMessages.findIndex((message) => message.id === throughMessageId);
    if (throughIndex < 0) {
      return;
    }
    const sourceMessages = currentMessages.slice(0, throughIndex + 1);
    const expected = this.contextCompaction.getCompaction();
    const next = await compactContext({
      messages: sourceMessages,
      current: expected,
      summarize: (prompt) => summarizeBuilderContext(prompt, accountCredentials),
    });
    if (!next) {
      return;
    }
    const latestIds = (this.messages as NonNullable<ChatRequestBody['messages']>).map((message) => message.id);
    if (
      !canApplyConversationCompaction({
        expectedFromId: next.fromMessageId,
        expectedThroughId: next.toMessageId,
        currentMessageIds: latestIds,
        currentThroughId: this.contextCompaction.getCompaction()?.toMessageId,
      })
    ) {
      return;
    }
    this.contextCompaction.saveCompactionIfCurrent(next, expected);
  }

  private async hasPendingContextCompaction(): Promise<boolean> {
    const fibers = await this.listFibers({
      name: CONTEXT_COMPACTION_FIBER,
      status: ['pending', 'running', 'interrupted'],
      limit: 1,
    });
    return fibers.length > 0;
  }

  protected override async onChatResponse(result: ChatResponseResult) {
    if (this.state.transcript) {
      await this.advanceTranscriptCheckpoint(this.state.transcript);
    }
    const currentTurn = this.state.activeTurn;
    if (!currentTurn) {
      return;
    }

    const status: BuilderTurnStatus =
      result.status === 'completed' ? 'completed' : result.status === 'aborted' ? 'aborted' : 'error';
    const compactAfterTurn = this.state.contextCompactionRequestedTurnId === currentTurn.id;
    this.finishTurn(currentTurn, {
      requestId: result.requestId,
      status,
      error: result.error,
    });
    if (compactAfterTurn) {
      this.setState({ ...this.state, contextCompactionRequestedTurnId: null });
    }
    const validatedSnapshot = await this.refreshDeploymentReadiness();
    if (status === 'completed') {
      if (compactAfterTurn && this.userId) {
        const throughMessageId = this.messages.at(-1)?.id;
        if (throughMessageId) {
          try {
            const credentials = await getUserWorkersAiCredentials(this.env, this.userId);
            await this.scheduleContextCompaction(throughMessageId, this.messages.length, credentials);
          } catch {
            logger.warn('Unable to queue post-turn context compaction');
          }
        }
      }
      if (validatedSnapshot) {
        await this.scheduleDeployment(validatedSnapshot).catch(() =>
          logger.warn('Unable to queue the automatic deployment'),
        );
      }
    }
  }

  @callable()
  async steerActiveTurn(input: unknown): Promise<{ accepted: true }> {
    await this.hydrateDurableIdentity({ required: true, reason: 'steer_active_turn' });
    if (!isRecord(input) || typeof input.text !== 'string') {
      throw new Response('Invalid steering message', { status: 400 });
    }
    const text = input.text.trim();
    if (!text || text.length > MAX_USER_MESSAGE_CHARACTERS) {
      throw new Response('Invalid steering message', { status: 400 });
    }
    const active = this.activeSteering;
    if (!active || this.state.activeTurn?.id !== active.turnId) {
      throw new Response('The builder is not currently running.', { status: 409 });
    }

    const message: UIMessage = {
      id: `steering-${crypto.randomUUID()}`,
      role: 'user',
      parts: [{ type: 'text', text }],
    };
    const reservation = active.queue.reserve(message, parseTurnContext(input.turnContext));
    if (!reservation) {
      throw new Response('The builder turn has already finished.', { status: 409 });
    }
    try {
      await this.persistMessages([...this.messages, message]);
      if (this.state.transcript) {
        await this.advanceTranscriptCheckpoint(this.state.transcript);
      }
      reservation.commit();
      return { accepted: true };
    } catch (error) {
      reservation.reject(error);
      throw error;
    }
  }

  @callable()
  async cancelActiveTurn(): Promise<unknown> {
    const deadline = Date.now() + CHAT_CANCELLATION_SETTLE_TIMEOUT_MS;
    const activeTurn = this.state.activeTurn;
    const validationCancellation = this.workspace.cancelActiveValidation();
    this.abortAllRequests(new DOMException('Cancelled by the project owner', 'AbortError'));
    if (activeTurn) {
      this.finishTurn(activeTurn, {
        status: 'aborted',
        error: 'Cancelled by the project owner',
      });
    }
    await waitForCancellationBeforeDeadline(validationCancellation, deadline);
    const remainingSettleTime = Math.max(0, deadline - Date.now());
    const settled = await this.waitUntilStable({
      timeout: remainingSettleTime,
      pendingInteraction: () => false,
    });
    if (!settled) {
      throw new Error('The cancelled builder turn did not settle before the cancellation timeout.');
    }
    const checkpoint = this.state.transcript ? await this.advanceTranscriptCheckpoint(this.state.transcript) : null;
    return {
      checkpoint,
      messages: this.messages as NonNullable<ChatRequestBody['messages']>,
    };
  }

  @callable()
  getWorkspaceState(): Promise<BuilderWorkspaceState> {
    return this.workspace.refresh();
  }

  @callable()
  async prepareWorkspace(): Promise<BuilderWorkspaceState> {
    if (!this.transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const state = await this.initializeWorkspace(this.transcriptBinding);
    await this.refreshDeploymentReadiness();
    return state;
  }

  @callable()
  getWorkspaceSyncPage(request: unknown): Promise<BuilderWorkspaceSyncPage> {
    return this.workspace.getSyncPage(request);
  }

  @callable()
  async applyWorkspaceClientChanges(request: unknown): Promise<BuilderWorkspaceApplyResult> {
    const result = await this.workspace.applyClientChanges(request);
    if (result.ok && result.changedPaths.length > 0) {
      this.setState({
        ...this.state,
        deployment: null,
        updatedAt: new Date().toISOString(),
      });
    }
    this.updatePreviewForWorkspace(result.state.revision);
    return result;
  }

  @callable()
  getPreviewState(): BuilderPreviewState {
    return this.currentPreviewState();
  }

  @callable()
  async deployValidatedRevision(): Promise<BuilderDeploymentState> {
    await this.hydrateDurableIdentity({ required: true, reason: 'deploy_validated_revision' });
    const snapshot = await validatedDeploymentCheckpoint(this.workspace);
    if (!snapshot) {
      throw new Error('The current project revision must pass validation before deployment.');
    }
    const current = this.state.deployment;
    if (current?.revision === snapshot.revision && (current.status === 'deploying' || current.status === 'succeeded')) {
      return current;
    }
    if (current?.revision === snapshot.revision && current.status === 'failed') {
      await this.terminalizeDeployment(snapshot);
    }
    await this.scheduleDeployment(snapshot, crypto.randomUUID());
    return this.state.deployment ?? { status: 'deploying', ...snapshot };
  }

  @callable()
  requestPreview(): Promise<BuilderPreviewState> {
    return this.requestPreviewInternal();
  }

  @callable()
  async cancelPreview(): Promise<BuilderPreviewState> {
    const preview = this.currentPreviewState();
    if (!preview.pendingId || (preview.status !== 'queued' && preview.status !== 'building')) {
      return preview;
    }
    await this.cancelFiberByKey(this.previewFiberKey(preview.pendingId), 'Cancelled by the project owner');
    await this.workspace.stopPreview(preview.pendingId).catch(() => undefined);
    const next: BuilderPreviewState = {
      ...preview,
      status: 'cancelled',
      pendingId: null,
      startedAt: null,
      updatedAt: new Date().toISOString(),
      error: null,
      active: null,
    };
    this.setPreviewState(next);
    return next;
  }

  @callable()
  async getTranscriptSnapshot(identityValue: unknown): Promise<{
    checkpoint: TranscriptCheckpoint | null;
    messages: NonNullable<ChatRequestBody['messages']>;
  }> {
    const checkpoint = await this.getTranscriptCheckpoint(identityValue);
    return {
      checkpoint,
      messages: this.messages as NonNullable<ChatRequestBody['messages']>,
    };
  }

  /**
   * Internal Worker RPC used by the authenticated transcript reload endpoint.
   * Direct namespace RPCs do not carry Agent connection props, so initialize
   * the same owner-scoped context before reading the durable transcript.
   */
  async getTranscriptSnapshotForOwner(
    identityValue: unknown,
    ownerId: string,
  ): ReturnType<BuilderAgent['getTranscriptSnapshot']> {
    if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 512) {
      throw new Response('Invalid transcript owner', { status: 400 });
    }
    await this.initializeIdentity({ ownerId, userId: ownerId });
    return this.getTranscriptSnapshot(identityValue);
  }

  @callable()
  async getTranscriptCheckpoint(identityValue: unknown): Promise<TranscriptCheckpoint | null> {
    const identity = this.requireTranscriptIdentity(identityValue);
    if (this.messages.length > 0) {
      return this.advanceTranscriptCheckpoint(identity);
    }
    return this.state.transcript ?? null;
  }

  protected override sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    const metadata = isRecord(message.metadata) ? message.metadata : null;
    if (!metadata || !Object.hasOwn(metadata, TRANSCRIPT_BASE_METADATA_KEY)) {
      return boundBuilderMessageForPersistence(message);
    }
    const sanitized = stripTranscriptBaseMetadata(message);
    const existing = this.messages.find((candidate) => candidate.id === message.id);
    if (existing && transcriptMessagesEqual(existing, message)) {
      return boundBuilderMessageForPersistence(sanitized);
    }
    const parsed = transcriptCheckpointSchema.nullable().safeParse(metadata[TRANSCRIPT_BASE_METADATA_KEY]);
    if (!parsed.success || !transcriptCheckpointsEqual(this.state.transcript ?? null, parsed.data)) {
      throw new Error('This transcript changed in another session. Reload the latest messages before sending.');
    }
    return boundBuilderMessageForPersistence(sanitized);
  }

  private requireTranscriptIdentity(value: unknown, subchatIndex?: number): TranscriptIdentity {
    return requireBuilderTranscriptIdentity(value, this.transcriptBinding, subchatIndex);
  }

  private async initializeIdentity(props: BuilderAgentProps): Promise<void> {
    if (
      typeof props.ownerId !== 'string' ||
      !props.ownerId ||
      props.ownerId.length > 512 ||
      typeof props.userId !== 'string' ||
      props.userId !== props.ownerId
    ) {
      throw new Response('Agent not found.', { status: 404 });
    }
    const transcriptBinding = await loadBuilderTranscriptBinding(this.env.DB, {
      agentName: this.name,
      ownerId: props.ownerId,
    });
    if (!transcriptBinding) {
      throw new Response('Agent not found.', { status: 404 });
    }
    const identity: BuilderAgentDurableIdentity = {
      ownerId: props.ownerId,
      userId: props.userId,
      transcript: transcriptBinding,
    };
    try {
      this.identityRepository.claim(identity);
    } catch (error) {
      if (error instanceof BuilderAgentIdentityMismatchError) {
        this.rejectIdentity('connection_identity_mismatch');
      }
      throw error;
    }
    this.applyIdentity(identity);
    const workspace = await this.initializeWorkspace(transcriptBinding);
    this.updatePreviewForWorkspace(workspace.revision);
  }

  private async hydrateDurableIdentity(args: {
    required: boolean;
    reason: string;
    incidentId?: string;
  }): Promise<BuilderAgentDurableIdentity | null> {
    const stored = this.identityRepository.get();
    if (!stored) {
      if (args.required) {
        this.rejectIdentity(`${args.reason}_missing`, args.incidentId, 401);
      }
      return null;
    }
    const activeTranscript = await loadBuilderTranscriptBinding(this.env.DB, {
      agentName: this.name,
      ownerId: stored.ownerId,
    });
    if (
      !activeTranscript ||
      !builderAgentIdentitiesEqual(stored, {
        ownerId: stored.ownerId,
        userId: stored.userId,
        transcript: activeTranscript,
      })
    ) {
      this.rejectIdentity(`${args.reason}_stale`, args.incidentId);
    }
    this.applyIdentity(stored);
    return stored;
  }

  private applyIdentity(identity: BuilderAgentDurableIdentity): void {
    if (
      (this.ownerId && this.ownerId !== identity.ownerId) ||
      (this.userId && this.userId !== identity.userId) ||
      (this.transcriptBinding &&
        !builderAgentIdentitiesEqual(
          {
            ownerId: this.ownerId ?? identity.ownerId,
            userId: this.userId ?? identity.userId,
            transcript: this.transcriptBinding,
          },
          identity,
        ))
    ) {
      this.rejectIdentity('memory_identity_mismatch');
    }
    this.ownerId = identity.ownerId;
    this.userId = identity.userId;
    this.transcriptBinding = identity.transcript;
  }

  private rejectIdentity(reason: string, incidentId: string = crypto.randomUUID(), status = 404): never {
    logger.error('Rejected BuilderAgent durable identity', {
      incidentId,
      reason,
    });
    throw new Response(status === 401 ? 'Agent authentication is required.' : 'Agent not found.', { status });
  }

  private async advanceTranscriptCheckpoint(identity: TranscriptIdentity): Promise<TranscriptCheckpoint> {
    const previous = this.state.transcript;
    const checkpoint = await advanceTranscriptCheckpoint(previous ?? null, identity, this.messages);
    if (checkpoint === previous) {
      return previous;
    }
    this.setState({ ...this.state, transcript: checkpoint, updatedAt: new Date().toISOString() });
    return checkpoint;
  }

  private stashTurn(turn: BuilderTurnState) {
    try {
      this.stash({
        kind: 'ghostbuild-chat-turn',
        turn,
        recoveryPlan: {
          onRecovery: 'Persist partial output and continue.',
          contextSource: 'durable AIChatAgent transcript plus this turn checkpoint',
        },
      });
    } catch {
      logger.warn('Unable to stash Ghostbuild chat turn recovery context');
    }
  }

  private async scheduleTitleGeneration(
    job: TitleGenerationJob,
    accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>,
  ): Promise<void> {
    await this.startFiber(
      TITLE_GENERATION_FIBER,
      async (fiber) => {
        fiber.stash({ ...job, version: 1 });
        await this.generateTitlesForPrompt({ ...job, accountCredentials });
      },
      {
        idempotencyKey: `${TITLE_GENERATION_FIBER}:${job.subchatIndex}:${job.promptGeneration}`,
        metadata: job,
      },
    );
  }

  private async generateTitlesForPrompt(
    args: TitleGenerationJob & {
      accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>;
    },
  ): Promise<void> {
    const ownerId = this.ownerId;
    if (!ownerId) {
      return;
    }

    // Start model work before persistence so the background request leaves the
    // critical chat path as soon as the first prompt is accepted.
    const conversationTitlePromise = generateConversationTitle(args.prompt, args.accountCredentials);
    const projectTitlePromise =
      args.firstPrompt && args.subchatIndex === 0 ? generateProjectTitle(args.prompt, args.accountCredentials) : null;
    const provisionalTitle = args.firstPrompt ? deriveProvisionalTitle(args.prompt) : null;

    if (provisionalTitle) {
      try {
        const [savedHeuristicProject, savedHeuristicSubchat] = await Promise.all([
          args.subchatIndex === 0
            ? setHeuristicProjectDescriptionIfMissing(this.env.DB, {
                sessionId: ownerId,
                id: args.chatInitialId,
                description: provisionalTitle,
              })
            : Promise.resolve(false),
          setHeuristicSubchatDescriptionIfMissing(this.env.DB, {
            sessionId: ownerId,
            id: args.chatInitialId,
            subchatIndex: args.subchatIndex,
            description: provisionalTitle,
            promptGeneration: args.promptGeneration,
          }),
        ]);
        if (savedHeuristicSubchat) {
          const updatedAt = new Date().toISOString();
          this.setState({
            ...this.state,
            generatedSubchatTitle: { subchatIndex: args.subchatIndex, title: provisionalTitle, updatedAt },
            updatedAt,
          });
        }
        logger.info('Saved heuristic titles for first prompt', {
          savedHeuristicProject,
          savedHeuristicSubchat,
        });
      } catch {
        logger.warn('Heuristic title save failed; continuing generated title work');
      }
    }

    const [conversationResult, projectResult] = await Promise.allSettled([
      conversationTitlePromise,
      projectTitlePromise ?? Promise.resolve(null),
    ]);

    if (conversationResult.status === 'fulfilled' && conversationResult.value) {
      try {
        const savedSubchatTitle = await setGeneratedSubchatDescription(this.env.DB, {
          sessionId: ownerId,
          id: args.chatInitialId,
          subchatIndex: args.subchatIndex,
          description: conversationResult.value,
          promptGeneration: args.promptGeneration,
        });
        if (savedSubchatTitle) {
          const updatedAt = new Date().toISOString();
          this.setState({
            ...this.state,
            generatedSubchatTitle: { subchatIndex: args.subchatIndex, title: conversationResult.value, updatedAt },
            updatedAt,
          });
        }
      } catch {
        logger.warn('Generated conversation title could not be saved');
      }
    } else if (conversationResult.status === 'rejected') {
      logger.warn('Conversation title generation failed; keeping the current title');
    }

    if (projectResult.status === 'fulfilled' && projectResult.value) {
      try {
        await setGeneratedProjectDescription(this.env.DB, {
          sessionId: ownerId,
          id: args.chatInitialId,
          description: projectResult.value,
        });
      } catch {
        logger.warn('Generated project title could not be saved');
      }
    } else if (projectResult.status === 'rejected') {
      logger.warn('Project title generation failed; keeping the first-prompt title');
    }
  }

  private async initializeWorkspace(binding: BuilderTranscriptBinding): Promise<BuilderWorkspaceState> {
    const current = await this.workspace.refresh();
    if (current.initialized) {
      return current;
    }
    if (binding.parentAgentName) {
      const parent = await this.loadParentWorkspace(binding.parentAgentName);
      return this.seedWorkspace(parentBuilderWorkspaceSeedId(parent.targetRevision), parent.entries);
    }
    const template = await loadBuilderTemplate();
    return this.seedWorkspace(builderTemplateSeedId(), template);
  }

  private async loadParentWorkspace(
    parentAgentName: string,
  ): Promise<{ entries: BuilderWorkspaceFileInput[]; targetRevision: number }> {
    const parent = this.env.BuilderAgent.getByName(parentAgentName) as unknown as Pick<
      BuilderAgent,
      'getWorkspaceState' | 'getWorkspaceSyncPage'
    >;
    const parentState = await parent.getWorkspaceState();
    if (!parentState.initialized) {
      throw new Error('The parent durable project workspace is not initialized.');
    }
    const entries: BuilderWorkspaceFileInput[] = [];
    let cursor: string | undefined;
    let targetRevision: number | undefined;
    while (true) {
      const page = await parent.getWorkspaceSyncPage({
        fromRevision: 0,
        ...(targetRevision !== undefined ? { targetRevision } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (page.restart) {
        entries.length = 0;
        cursor = undefined;
        targetRevision = undefined;
        continue;
      }
      targetRevision = page.targetRevision;
      for (const entry of page.entries) {
        if (entry.kind === 'write') {
          entries.push({ path: entry.path, content: entry.content, encoding: entry.encoding });
        }
      }
      if (!page.nextCursor) {
        return { entries, targetRevision: page.targetRevision };
      }
      cursor = page.nextCursor;
    }
  }

  private async seedWorkspace(seedId: string, entries: BuilderWorkspaceFileInput[]): Promise<BuilderWorkspaceState> {
    return seedBuilderWorkspace(this.workspace, seedId, entries);
  }

  private async terminalizeDeployment(job: DeploymentJob): Promise<BuilderDeploymentState> {
    const userId = this.userId;
    const transcriptBinding = this.transcriptBinding;
    if (!userId || !transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    return terminalizeInterruptedDeploymentForBuilder({
      context: {
        env: this.env,
        userId,
        chatInitialId: transcriptBinding.chatInitialId,
      },
      workspace: this.workspace,
      toolCallId: `deploy-command:${job.workspaceRevision}:${job.revision}`,
      validatedRevision: job.revision,
    });
  }

  private async scheduleDeployment(job: DeploymentJob, retryId?: string): Promise<void> {
    const current = this.state.deployment;
    if (
      !retryId &&
      current?.revision === job.revision &&
      (current.status === 'deploying' || current.status === 'succeeded' || current.status === 'failed')
    ) {
      return;
    }
    this.setState({
      ...this.state,
      deployment: { status: 'deploying', ...job },
      updatedAt: new Date().toISOString(),
    });
    try {
      await this.startFiber(
        DEPLOYMENT_FIBER,
        async (fiber) => {
          fiber.stash(job);
          try {
            const deployment = await this.runDeployment(job);
            if (deployment.status === 'succeeded') {
              await this.requestPreviewInternal({ validatedSnapshot: job }).catch(() =>
                logger.warn('Unable to queue the post-deployment preview'),
              );
            }
          } catch (error) {
            this.failDeployment(job, error);
            throw error;
          }
        },
        {
          idempotencyKey: `builder-deployment:${this.name}:${job.workspaceRevision}:${job.revision}${
            retryId ? `:retry:${retryId}` : ''
          }`,
          metadata: job,
        },
      );
    } catch (error) {
      this.failDeployment(job, error);
      throw error;
    }
  }

  private async runDeployment(job: DeploymentJob): Promise<BuilderDeploymentState> {
    const userId = this.userId;
    const transcriptBinding = this.transcriptBinding;
    if (!userId || !transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const deployment = await this.keepAliveWhile(() =>
      deployValidatedRevisionForBuilder({
        context: {
          env: this.env,
          userId,
          chatInitialId: transcriptBinding.chatInitialId,
        },
        workspace: this.workspace,
        toolCallId: `deploy-command:${job.workspaceRevision}:${job.revision}`,
        validatedRevision: job.revision,
      }),
    );
    const revisionBoundDeployment = { ...deployment, ...job };
    this.setDeploymentResult(job, revisionBoundDeployment);
    return revisionBoundDeployment;
  }

  private failDeployment(job: DeploymentJob, error: unknown): BuilderDeploymentState {
    const deployment = { status: 'failed' as const, ...job, error: deploymentErrorMessage(error) };
    this.setDeploymentResult(job, deployment);
    return deployment;
  }

  private setDeploymentResult(job: DeploymentJob, deployment: BuilderDeploymentState): void {
    if (this.state.deployment?.revision !== job.revision) {
      return;
    }
    this.setState({ ...this.state, deployment, updatedAt: new Date().toISOString() });
  }

  private async requestPreviewInternal(
    options: { validatedSnapshot?: BuilderWorkspaceCheckpoint } = {},
  ): Promise<BuilderPreviewState> {
    if (!this.ownerId || !this.userId || !this.transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const workspace = await this.initializeWorkspace(this.transcriptBinding);
    const current = this.currentPreviewState();
    const snapshot = options.validatedSnapshot ?? (await this.workspace.checkpoint());
    if (
      current.workspaceRevision === workspace.revision &&
      (current.status === 'queued' || current.status === 'building')
    ) {
      return current;
    }
    if (
      current.status === 'ready' &&
      current.active?.snapshotRevision === snapshot.revision &&
      Date.parse(current.active.expiresAt) > Date.now()
    ) {
      return current;
    }
    if (current.pendingId && (current.status === 'queued' || current.status === 'building')) {
      await this.cancelPreview();
    }

    const previewId = crypto.randomUUID();
    const requestedAt = Date.now();
    const job: PreviewBuildJob = {
      previewId,
      workspaceRevision: snapshot.workspaceRevision,
      snapshotRevision: snapshot.revision,
      requestedAt,
    };
    const queued: BuilderPreviewState = {
      status: 'queued',
      pendingId: previewId,
      workspaceRevision: snapshot.workspaceRevision,
      currentWorkspaceRevision: workspace.revision,
      stale: snapshot.workspaceRevision !== workspace.revision,
      attempt: 0,
      requestedAt: new Date(requestedAt).toISOString(),
      startedAt: null,
      updatedAt: new Date().toISOString(),
      error: null,
      active: null,
      lastSuccessful: current.lastSuccessful ?? current.active,
    };
    this.setPreviewState(queued);
    try {
      await this.startFiber(
        PREVIEW_BUILD_FIBER,
        async (fiber) => {
          fiber.stash(job);
          await this.runPreviewBuild(job);
        },
        {
          idempotencyKey: this.previewFiberKey(previewId),
          metadata: job,
        },
      );
    } catch (error) {
      await this.failPreviewJob(
        job,
        error instanceof Error ? error.message : 'The durable preview job could not be started.',
      );
      throw error;
    }
    return this.currentPreviewState();
  }

  private async runPreviewBuild(job: PreviewBuildJob): Promise<void> {
    if (!this.isCurrentPreviewJob(job.previewId)) {
      return;
    }
    const startedAt = Date.now();
    try {
      this.setPreviewState({
        ...this.currentPreviewState(),
        status: 'building',
        startedAt: new Date(startedAt).toISOString(),
        updatedAt: new Date(startedAt).toISOString(),
      });
      const success = await this.workspace.createPreview({
        previewId: job.previewId,
        expectedWorkspaceRevision: job.workspaceRevision,
        expectedSnapshotRevision: job.snapshotRevision,
      });
      if (!this.isCurrentPreviewJob(job.previewId)) {
        await this.workspace.stopPreview(job.previewId).catch(() => undefined);
        return;
      }
      const readyAt = Date.parse(success.readyAt);
      const previous = this.currentPreviewState().lastSuccessful;
      const currentSnapshot = await this.workspace.checkpoint();
      this.setPreviewState({
        status: 'ready',
        pendingId: null,
        workspaceRevision: job.workspaceRevision,
        currentWorkspaceRevision: currentSnapshot.workspaceRevision,
        stale: currentSnapshot.revision !== job.snapshotRevision,
        attempt: this.currentPreviewState().attempt,
        requestedAt: new Date(job.requestedAt).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        updatedAt: new Date(readyAt).toISOString(),
        error: null,
        active: success,
        lastSuccessful: success,
      });
      if (previous && previous.id !== success.id) {
        await this.workspace
          .stopPreview(previous.id)
          .catch(() => logger.warn('Unable to retire the superseded remote preview'));
      }
    } catch (error) {
      await this.failPreviewJob(
        job,
        (error instanceof Error ? error.message : 'The isolated remote preview build failed.').slice(-4_000),
      );
    }
  }

  private async failPreviewJob(job: PreviewBuildJob, error: string): Promise<void> {
    if (!this.isCurrentPreviewJob(job.previewId)) {
      return;
    }
    const current = this.currentPreviewState();
    const revision =
      (
        await this.workspace.refresh().catch((refreshError) => {
          logger.warn('Unable to refresh workspace revision for preview failure', refreshError);
          return null;
        })
      )?.revision ?? current.currentWorkspaceRevision;
    this.setPreviewState(failedBuilderPreviewState(current, revision, error));
  }

  private previewFiberKey(previewId: string): string {
    return `builder-preview:${this.name}:${previewId}`;
  }

  private isCurrentPreviewJob(previewId: string): boolean {
    return this.state.preview?.pendingId === previewId;
  }

  private currentPreviewState(): BuilderPreviewState {
    const revision = this.workspace.getState().revision;
    const stored = this.state.preview ?? idleBuilderPreviewState(revision);
    const successful = stored.active ?? stored.lastSuccessful;
    const expired = successful ? Date.parse(successful.expiresAt) <= Date.now() : false;
    return {
      ...stored,
      status: expired && stored.status === 'ready' ? 'expired' : stored.status,
      currentWorkspaceRevision: revision,
      stale: stored.stale,
      active: expired ? null : stored.active,
    };
  }

  private updatePreviewForWorkspace(revision: number): void {
    const preview = this.state.preview ?? idleBuilderPreviewState(revision);
    this.setPreviewState(previewStateForWorkspace(preview, revision));
  }

  private setPreviewState(preview: BuilderPreviewState): void {
    this.setState({ ...this.state, preview, updatedAt: preview.updatedAt });
  }

  private async refreshDeploymentReadiness(): Promise<BuilderWorkspaceCheckpoint | null> {
    let validatedSnapshot: BuilderWorkspaceCheckpoint | null = null;
    try {
      validatedSnapshot = await validatedDeploymentCheckpoint(this.workspace);
    } catch {
      logger.warn('Unable to refresh deployment readiness');
    }
    const currentDeployment = this.state.deployment;
    const deployment = validatedSnapshot
      ? currentDeployment?.revision === validatedSnapshot.revision
        ? currentDeployment
        : { status: 'ready' as const, ...validatedSnapshot }
      : null;
    this.setState({
      ...this.state,
      deployment,
      updatedAt: new Date().toISOString(),
    });
    return validatedSnapshot;
  }

  private setValidationProgress(toolCallId: string, stage: BuilderValidationStage | null): void {
    if (stage === null && this.state.validationProgress?.toolCallId !== toolCallId) {
      return;
    }
    const updatedAt = new Date().toISOString();
    this.setState({
      ...this.state,
      validationProgress: stage ? { toolCallId, stage, updatedAt } : null,
      updatedAt,
    });
  }

  private recordTurnBudget(turnId: string, budget: BuilderTurnBudgetReport) {
    const activeTurn = this.state.activeTurn;
    if (activeTurn?.id !== turnId) {
      return;
    }
    const updatedTurn = recordBuilderTurnBudget(activeTurn, budget);
    this.setState({ ...this.state, activeTurn: updatedTurn, updatedAt: updatedTurn.updatedAt });
  }

  private finishTurn(
    turn: BuilderTurnState,
    result: { status: BuilderTurnStatus; requestId?: string; error?: string },
  ) {
    const finishedTurn = completeBuilderTurn(turn, result);
    this.setState({
      ...this.state,
      activeTurn: null,
      lastCompletedTurn: finishedTurn,
      validationProgress: null,
      updatedAt: finishedTurn.updatedAt,
    });
  }
}

function parseTurnContext(value: unknown): ChatTurnContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = chatTurnContextSchema.safeParse(value);
  if (!result.success) {
    throw new Response('Invalid turn context', { status: 400 });
  }
  return result.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTitleGenerationJob(value: unknown): TitleGenerationJob | null {
  if (
    !isRecord(value) ||
    typeof value.chatInitialId !== 'string' ||
    value.chatInitialId.length === 0 ||
    typeof value.firstPrompt !== 'boolean' ||
    typeof value.prompt !== 'string' ||
    value.prompt.length === 0 ||
    value.prompt.length > TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS ||
    !Number.isSafeInteger(value.promptGeneration) ||
    (value.promptGeneration as number) < 1 ||
    !Number.isSafeInteger(value.subchatIndex) ||
    (value.subchatIndex as number) < 0
  ) {
    return null;
  }
  return value as TitleGenerationJob;
}

function parseDeploymentJob(value: unknown): DeploymentJob | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.workspaceRevision) ||
    (value.workspaceRevision as number) < 0 ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.revision)
  ) {
    return null;
  }
  return value as DeploymentJob;
}

function deploymentErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Deployment failed.';
}

function parsePreviewBuildJob(value: unknown): PreviewBuildJob | null {
  if (!isRecord(value)) {
    return null;
  }
  const stringKeys = ['previewId', 'snapshotRevision'] as const;
  if (
    stringKeys.some((key) => typeof value[key] !== 'string' || (value[key] as string).length === 0) ||
    !Number.isSafeInteger(value.workspaceRevision) ||
    (value.workspaceRevision as number) < 0 ||
    !Number.isSafeInteger(value.requestedAt) ||
    (value.requestedAt as number) <= 0
  ) {
    return null;
  }
  return value as PreviewBuildJob;
}
