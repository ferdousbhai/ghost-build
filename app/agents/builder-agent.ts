import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
  type ChatResponseResult,
} from '@cloudflare/ai-chat';
import { callable, type FiberRecoveryContext, type FiberRecoveryResult } from 'agents';
import { canApplyConversationCompaction, conversationCompactionKey } from '@summonghost/compaction';
import { createChatResponseFromBody, type ChatRequestBody } from '~/lib/.server/chat';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import {
  BuilderTurnStore,
  completeBuilderTurn,
  createBuilderTurn,
  createRecoveryTurn,
  type BuilderTurnState,
  type BuilderTurnStatus,
} from './builder-turn-store';
import { DurableObjectContextCompactionRepository } from '~/lib/.server/llm/context-compaction-store';
import { compactContext } from '~/lib/.server/llm/context-compaction';
import { summarizeBuilderContext } from '~/lib/.server/llm/workers-ai-text';
import { chatTurnContextSchema, type ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { getUserWorkersAiCredentials } from '~/lib/.server/cloudflare/workers-ai-billing-context';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { latestPendingDeploymentPlanMarker } from './deployment-continuation';
import { generateProjectTitle } from '~/lib/.server/llm/project-title';
import {
  setGeneratedDescriptionIfMissing,
  setGeneratedSubchatDescription,
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
  assertBuilderModelTranscriptWithinLimit,
  boundBuilderMessageForPersistence,
  loadBuilderTranscriptBinding,
  MAX_BUILDER_AGENT_MESSAGES,
  requireBuilderRequestScope,
  requireBuilderSeedTranscript,
  requireBuilderTranscriptIdentity,
  type BuilderTranscriptBinding,
} from './builder-request-policy';
import { initializeBuilderAgentSchema } from './builder-agent-schema';
import { BuilderWorkspaceRepository } from './builder-workspace';
import type {
  BuilderWorkspaceFileInput,
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from './builder-workspace-types';
import {
  batchBuilderWorkspaceSeed,
  builderTemplateSeedId,
  builderTemplateTotals,
  loadBuilderTemplate,
} from './builder-template';
import { deriveProvisionalTitle } from '@summonghost/title-generation';
import { deleteObject, getObjectBytes, putObjectBytesAtKey } from '~/lib/cloudflare/data/object-storage.server';
import {
  BUILDER_PREVIEW_MAX_ATTEMPTS,
  BUILDER_PREVIEW_PORT,
  BUILDER_PREVIEW_TTL_MS,
  failedBuilderPreviewState,
  idleBuilderPreviewState,
  previewStateForWorkspace,
  type BuilderPreviewState,
  type BuilderPreviewSuccess,
} from './builder-preview-types';
import { createBuilderWorkspaceSnapshot } from './builder-workspace-snapshot';
import { buildBuilderPreview } from '~/lib/.server/cloudflare/builder-preview-sandbox';
import {
  acquirePreviewBuildAdmission,
  markPreviewReady,
  previewAccessTokenHash,
  previewPath,
  registerBuildingPreview,
  releasePreviewBuildAdmission,
  retireBuilderPreview,
} from '~/lib/.server/cloudflare/builder-preview-repository';

const logger = createScopedLogger('BuilderAgent');
const STALE_CHAT_RECOVERY_MS = 30 * 60 * 1000;
const MAX_CHAT_RECOVERY_ATTEMPTS = 2;
const CHAT_NO_PROGRESS_TIMEOUT_MS = 25 * 60 * 1000;
const CONTEXT_COMPACTION_FIBER = 'background:context_compaction';
const PREVIEW_BUILD_FIBER = 'background:builder_preview';
const PREVIEW_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;
const PREVIEW_BUILD_LEASE_MS = 12 * 60 * 1000;
const CHAT_CANCELLATION_SETTLE_TIMEOUT_MS = 5 * 60 * 1000;

type PreviewBuildJob = {
  previewId: string;
  sandboxId: string;
  snapshotKey: string;
  workspaceRevision: number;
  snapshotRevision: string;
  ownerId: string;
  chatInitialId: string;
  agentName: string;
  requestedAt: number;
  accessToken: string;
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
  };

  override messageConcurrency = 'drop' as const;

  override maxPersistedMessages = MAX_BUILDER_AGENT_MESSAGES;

  override waitForMcpConnections = { timeout: 10_000 };

  override chatRecovery = {
    maxAttempts: MAX_CHAT_RECOVERY_ATTEMPTS,
    noProgressTimeoutMs: CHAT_NO_PROGRESS_TIMEOUT_MS,
    terminalMessage: 'The builder was interrupted. Please send your message again.',
  };

  override chatStreamStallTimeoutMs = CHAT_NO_PROGRESS_TIMEOUT_MS;

  private readonly turnStore = new BuilderTurnStore(this);
  private readonly contextCompaction = new DurableObjectContextCompactionRepository(this);
  private readonly workspace: BuilderWorkspaceRepository;
  private ownerId: string | null = null;
  private userId: string | null = null;
  private transcriptBinding: BuilderTranscriptBinding | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeBuilderAgentSchema(ctx);
    this.workspace = new BuilderWorkspaceRepository(
      ctx.storage,
      {
        put: async (key, value) => {
          if (!(value instanceof Uint8Array)) {
            throw new Error('Builder workspace object bytes are invalid.');
          }
          await putObjectBytesAtKey(env, key, value);
        },
        get: async (key) => {
          const bytes = await getObjectBytes(env, key);
          return bytes
            ? {
                arrayBuffer: async () => bytes.slice().buffer,
              }
            : null;
        },
        delete: async (keys) => {
          await Promise.all((Array.isArray(keys) ? keys : [keys]).map((key) => deleteObject(env, key)));
        },
      },
      ctx.id.toString(),
      () => this.userId,
    );
  }

  async onStart(props?: BuilderAgentProps) {
    if (props) {
      await this.initializeIdentity(props);
    }
  }

  /**
   * Accept durable deletion without making the caller wait for the
   * abort-shaped `destroy()` RPC. This is intentionally not decorated with
   * `@callable`: it is an internal Durable Object RPC used only by the D1 GC
   * outbox.
   */
  async scheduleDestroyForGc(): Promise<void> {
    const previewJobs = [
      ...this.ctx.storage.sql.exec<{ id: string; sandbox_id: string; snapshot_key: string }>(
        `SELECT id, sandbox_id, snapshot_key FROM builder_preview_jobs`,
      ),
    ];
    for (const preview of previewJobs) {
      await this.cancelFiberByKey(this.previewFiberKey(preview.id), 'Project deletion').catch(() => undefined);
      await retireBuilderPreview(this.env, preview.id, 'cancelled', Date.now(), preview).catch(() => undefined);
    }
    await this.workspace.deleteExternalObjects();
    await this._cf_scheduleDestroy();
  }

  override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
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
        requestId: ctx.requestId,
      });
      return { persist: true, continue: false };
    }
    const ageMs = Date.now() - ctx.createdAt;
    const nextTurn = createRecoveryTurn(ctx, this.state.activeTurn);
    this.setState({
      ...this.state,
      activeTurn: nextTurn,
      updatedAt: nextTurn.updatedAt,
    });
    this.turnStore.record(nextTurn);

    logger.warn('Recovering interrupted Ghostbuild chat turn', {
      incidentId: nextTurn.recovery?.incidentId,
      recoveryKind: ctx.recoveryKind,
      requestId: nextTurn.requestId,
      attempt: ctx.attempt,
      ageMs,
      partialTextLength: ctx.partialText.length,
      hasRecoveryData: ctx.recoveryData !== undefined,
    });

    if (ageMs > STALE_CHAT_RECOVERY_MS) {
      logger.warn('Skipping automatic continuation for stale Ghostbuild chat turn', {
        incidentId: ctx.incidentId,
        ageMs,
      });
      return { persist: true, continue: false };
    }

    return {};
  }

  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    if (ctx.name === PREVIEW_BUILD_FIBER) {
      const job = parsePreviewBuildJob(ctx.metadata);
      if (!job) {
        return { status: 'error', error: 'missing preview build recovery data' };
      }
      await this.runPreviewBuild(job);
      return { status: 'completed', snapshot: ctx.snapshot };
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
    if (!this.ownerId || !this.userId) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const body = (options?.body ?? {}) as ChatBody;
    const messages = this.messages as NonNullable<ChatRequestBody['messages']>;
    const { chatInitialId, subchatIndex, transcript } = requireBuilderRequestScope(body, this.transcriptBinding);
    assertBuilderModelTranscriptWithinLimit(messages);
    const pendingDeploymentPlanMarker = options?.continuation ? latestPendingDeploymentPlanMarker(messages) : null;
    if (pendingDeploymentPlanMarker) {
      console.info({
        event: 'builder_deployment_plan_continuation_stopped',
      });
      return createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: ({ writer }) => {
            const id = 'deployment-approval-ready';
            writer.write({ type: 'text-start', id });
            writer.write({
              type: 'text-delta',
              id,
              delta: `The production plan is ready. Review the Cloudflare resources and approve billing below.\n\n${pendingDeploymentPlanMarker}`,
            });
            writer.write({ type: 'text-end', id });
          },
        }),
      });
    }
    await this.advanceTranscriptCheckpoint(transcript);
    this.contextCompaction.migrateLegacySubchat(subchatIndex);
    const turnContext = parseTurnContext(body.turnContext);
    const firstUserMessage =
      !options?.continuation && messages.filter((message: { role?: string }) => message.role === 'user').length === 1;
    const firstPrompt = firstUserMessage ? messages.find((message) => message.role === 'user') : undefined;
    const turn = createBuilderTurn({
      requestId: options?.requestId,
      chatInitialId,
      continuation: options?.continuation === true,
      firstUserMessage,
      messages,
    });
    console.info({
      event: 'builder_chat_turn_started',
      requestId: turn.requestId,
      chatInitialId,
      continuation: options?.continuation === true,
      firstUserMessage,
      messageCount: messages.length,
    });
    this.setState({
      ...this.state,
      activeTurn: turn,
      updatedAt: turn.updatedAt,
    });
    this.turnStore.record(turn);

    try {
      const accountCredentials = await getUserWorkersAiCredentials(this.env, this.userId);
      if (firstPrompt) {
        this.ctx.waitUntil(
          this.generateTitlesForFirstPrompt(chatInitialId, subchatIndex, messageText(firstPrompt), accountCredentials),
        );
      }
      this.stashTurn(turn);
      const compactionPending = await this.hasPendingContextCompaction();
      return await createChatResponseFromBody({
        env: this.env,
        abortSignal: options?.abortSignal,
        firstUserMessage,
        turnContext,
        accountCredentials,
        sessionAffinity: await createWorkersAiSessionAffinity(transcript),
        workspace: this.workspace,
        userId: this.userId,
        agentName: this.name,
        compaction: {
          current: this.contextCompaction.getCompaction(),
          pending: compactionPending,
          summarize: (prompt) => summarizeBuilderContext(this.env, prompt, accountCredentials),
          save: (compaction) => this.contextCompaction.saveCompaction(compaction),
          schedule: async () => {
            const throughMessageId = messages.at(-1)?.id;
            if (!throughMessageId || (await this.hasPendingContextCompaction())) {
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
                  revision: messages.length,
                }),
                metadata: { throughMessageId },
              },
            );
          },
        },
        body: {
          messages,
          chatInitialId,
        },
      });
    } catch (error) {
      this.finishTurn(turn, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
      summarize: (prompt) => summarizeBuilderContext(this.env, prompt, accountCredentials),
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
    this.finishTurn(currentTurn, {
      requestId: result.requestId,
      status,
      error: result.error,
    });
    if (status === 'completed') {
      await this.requestPreviewInternal().catch((error) =>
        logger.warn('Unable to queue the automatic remote preview', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  @callable()
  getTurnHistory(limit = 20) {
    return this.turnStore.getHistory(limit);
  }

  @callable()
  async cancelActiveTurn(): Promise<unknown> {
    const activeTurn = this.state.activeTurn;
    this.abortAllRequests(new DOMException('Cancelled by the project owner', 'AbortError'));
    if (activeTurn) {
      this.finishTurn(activeTurn, {
        status: 'aborted',
        error: 'Cancelled by the project owner',
      });
    }
    const settled = await this.waitUntilStable({
      timeout: CHAT_CANCELLATION_SETTLE_TIMEOUT_MS,
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
  getWorkspaceState(): BuilderWorkspaceState {
    return this.workspace.getState();
  }

  @callable()
  async prepareWorkspace(): Promise<BuilderWorkspaceState> {
    if (!this.transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    return this.initializeWorkspace(this.transcriptBinding);
  }

  @callable()
  getWorkspaceSyncPage(request: unknown): Promise<BuilderWorkspaceSyncPage> {
    return this.workspace.getSyncPage(request);
  }

  @callable()
  async applyWorkspaceClientChanges(request: unknown): Promise<BuilderWorkspaceApplyResult> {
    const result = await this.workspace.applyClientChanges(request);
    this.updatePreviewForWorkspace(result.state.revision);
    return result;
  }

  @callable()
  getPreviewState(): BuilderPreviewState {
    return this.currentPreviewState();
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
    const job = [
      ...this.ctx.storage.sql.exec<{ sandbox_id: string; snapshot_key: string }>(
        `SELECT sandbox_id, snapshot_key FROM builder_preview_jobs WHERE id = ?`,
        preview.pendingId,
      ),
    ][0];
    await retireBuilderPreview(this.env, preview.pendingId, 'cancelled', Date.now(), job).catch(() => undefined);
    this.ctx.storage.sql.exec(
      `UPDATE builder_preview_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      Date.now(),
      preview.pendingId,
    );
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
  async getTranscriptSnapshot(identityValue?: unknown): Promise<{
    checkpoint: TranscriptCheckpoint | null;
    messages: NonNullable<ChatRequestBody['messages']>;
  }> {
    const checkpoint =
      identityValue === undefined ? (this.state.transcript ?? null) : await this.getTranscriptCheckpoint(identityValue);
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
    if (!this.state.transcript && this.messages.length > 0) {
      return this.advanceTranscriptCheckpoint(identity);
    }
    return this.state.transcript ?? null;
  }

  @callable()
  async seedTranscript(identityValue: unknown, messagesValue: unknown): Promise<TranscriptCheckpoint> {
    const identity = this.requireTranscriptIdentity(identityValue);
    const messages = requireBuilderSeedTranscript(messagesValue);
    if (this.state.transcript || this.messages.length > 0) {
      return this.advanceTranscriptCheckpoint(identity);
    }
    await this.persistMessages(messages);
    return this.advanceTranscriptCheckpoint(identity);
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
    if (this.ownerId && this.ownerId !== props.ownerId) {
      throw new Response('Agent not found.', { status: 404 });
    }
    const transcriptBinding = await loadBuilderTranscriptBinding(this.env.DB, {
      agentName: this.name,
      ownerId: props.ownerId,
    });
    if (!transcriptBinding) {
      throw new Response('Agent not found.', { status: 404 });
    }
    this.ownerId = props.ownerId;
    this.userId = props.userId;
    this.transcriptBinding = transcriptBinding;
    const workspace = await this.initializeWorkspace(transcriptBinding);
    this.updatePreviewForWorkspace(workspace.revision);
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
          onRecovery: 'Persist partial output and continue only when the turn is recent.',
          staleRecoveryMs: STALE_CHAT_RECOVERY_MS,
          contextSource: 'durable AIChatAgent transcript plus this turn checkpoint',
        },
      });
    } catch (error) {
      logger.warn('Unable to stash Ghostbuild chat turn recovery context', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async generateTitlesForFirstPrompt(
    chatInitialId: string,
    subchatIndex: number,
    firstPrompt: string,
    accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>,
  ): Promise<void> {
    if (!this.ownerId) {
      return;
    }
    try {
      const title = await generateProjectTitle(this.env, firstPrompt, accountCredentials);
      if (!title) {
        return;
      }
      const [savedProjectTitle, savedSubchatTitle] = await Promise.all([
        setGeneratedDescriptionIfMissing(this.env.DB, {
          sessionId: this.ownerId,
          id: chatInitialId,
          description: title,
        }),
        setGeneratedSubchatDescription(this.env.DB, {
          sessionId: this.ownerId,
          id: chatInitialId,
          subchatIndex,
          description: title,
          provisionalDescription: deriveProvisionalTitle(firstPrompt),
        }),
      ]);
      if (savedSubchatTitle) {
        const updatedAt = new Date().toISOString();
        this.setState({
          ...this.state,
          generatedSubchatTitle: { subchatIndex, title, updatedAt },
          updatedAt,
        });
      }
      logger.info('Generated titles for first prompt', {
        chatInitialId,
        subchatIndex,
        savedProjectTitle,
        savedSubchatTitle,
      });
    } catch (error) {
      logger.warn('Title generation failed; keeping first-prompt fallback', {
        chatInitialId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async initializeWorkspace(binding: BuilderTranscriptBinding): Promise<BuilderWorkspaceState> {
    const current = this.workspace.getState();
    if (current.initialized) {
      return current;
    }
    if (binding.parentAgentName) {
      const parentEntries = await this.loadParentWorkspace(binding.parentAgentName);
      return this.seedWorkspace(`parent_${crypto.randomUUID()}`, parentEntries);
    }
    const template = await loadBuilderTemplate();
    return this.seedWorkspace(builderTemplateSeedId(), template);
  }

  private async loadParentWorkspace(parentAgentName: string): Promise<BuilderWorkspaceFileInput[]> {
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
        return entries;
      }
      cursor = page.nextCursor;
    }
  }

  private async seedWorkspace(seedId: string, entries: BuilderWorkspaceFileInput[]): Promise<BuilderWorkspaceState> {
    const started = await this.workspace.beginSeed(seedId);
    if (started.status === 'initialized') {
      return started.state;
    }
    if (started.status === 'seeding' && started.state.seeding) {
      throw new Error('The durable project workspace is already being initialized.');
    }
    try {
      for (const batch of batchBuilderWorkspaceSeed(entries)) {
        await this.workspace.appendSeed(seedId, batch);
      }
      return await this.workspace.commitSeed(seedId, builderTemplateTotals(entries));
    } catch (error) {
      await this.workspace.abortSeed(seedId).catch(() => undefined);
      throw error;
    }
  }

  private async requestPreviewInternal(): Promise<BuilderPreviewState> {
    if (!this.ownerId || !this.userId || !this.transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const workspace = await this.initializeWorkspace(this.transcriptBinding);
    const current = this.currentPreviewState();
    if (
      current.workspaceRevision === workspace.revision &&
      (current.status === 'queued' || current.status === 'building')
    ) {
      return current;
    }
    if (
      current.status === 'ready' &&
      current.active?.workspaceRevision === workspace.revision &&
      Date.parse(current.active.expiresAt) > Date.now()
    ) {
      return current;
    }
    if (current.pendingId && (current.status === 'queued' || current.status === 'building')) {
      await this.cancelPreview();
    }

    const snapshot = await createBuilderWorkspaceSnapshot(this.workspace);
    const previewId = crypto.randomUUID();
    const accessToken = createPreviewAccessToken();
    const snapshotKey = `builder-previews/${previewId}.zip`;
    const requestedAt = Date.now();
    const job: PreviewBuildJob = {
      previewId,
      sandboxId: `preview-${previewId.replaceAll('-', '')}`,
      snapshotKey,
      workspaceRevision: snapshot.workspaceRevision,
      snapshotRevision: snapshot.revision,
      ownerId: this.ownerId,
      chatInitialId: this.transcriptBinding.chatInitialId,
      agentName: this.name,
      requestedAt,
      accessToken,
    };
    await this.env.APP_STORAGE.put(snapshotKey, snapshot.bytes);
    this.recordPreviewJob(job, 'queued');
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
      await this.env.APP_STORAGE.delete(job.snapshotKey).catch(() => undefined);
      return;
    }
    const chat = await this.env.DB.prepare(
      `SELECT id
       FROM chats
       WHERE initial_id = ? AND creator_id = ? AND is_deleted = 0
       LIMIT 1`,
    )
      .bind(job.chatInitialId, job.ownerId)
      .first<{ id: string }>();
    if (!chat) {
      await this.failPreviewJob(job, 'The project was deleted before its preview could start.');
      return;
    }

    let admitted = false;
    for (let attempt = 1; attempt <= BUILDER_PREVIEW_MAX_ATTEMPTS; attempt += 1) {
      if (!this.isCurrentPreviewJob(job.previewId)) {
        await this.env.APP_STORAGE.delete(job.snapshotKey).catch(() => undefined);
        return;
      }
      const now = Date.now();
      const current = this.currentPreviewState();
      this.setPreviewState({
        ...current,
        status: 'queued',
        attempt,
        updatedAt: new Date(now).toISOString(),
        error: null,
      });
      const admission = await acquirePreviewBuildAdmission(this.env.DB, {
        previewId: job.previewId,
        ownerId: job.ownerId,
        agentName: job.agentName,
        sandboxId: job.sandboxId,
        now,
        expiresAt: now + PREVIEW_BUILD_LEASE_MS,
      });
      if (admission.admitted) {
        admitted = true;
        break;
      }
      if (admission.reason === 'hourly-quota') {
        await this.failPreviewJob(job, 'The hourly remote preview quota is exhausted. Try again later.');
        return;
      }
      if (attempt < BUILDER_PREVIEW_MAX_ATTEMPTS) {
        await delay(PREVIEW_RETRY_DELAYS_MS[attempt - 1] ?? 30_000);
      }
    }
    if (!admitted) {
      await this.failPreviewJob(job, 'Remote preview capacity is busy. The build stayed queued through every retry.');
      return;
    }

    const startedAt = Date.now();
    try {
      await registerBuildingPreview(this.env.DB, {
        id: job.previewId,
        ownerId: job.ownerId,
        chatId: chat.id,
        agentName: job.agentName,
        sandboxId: job.sandboxId,
        snapshotKey: job.snapshotKey,
        accessTokenHash: await previewAccessTokenHash(job.accessToken),
        workspaceRevision: job.workspaceRevision,
        snapshotRevision: job.snapshotRevision,
        port: BUILDER_PREVIEW_PORT,
        createdAt: job.requestedAt,
        expiresAt: startedAt + PREVIEW_BUILD_LEASE_MS,
      });
      this.recordPreviewJob(job, 'building');
      this.setPreviewState({
        ...this.currentPreviewState(),
        status: 'building',
        startedAt: new Date(startedAt).toISOString(),
        updatedAt: new Date(startedAt).toISOString(),
      });
      await buildBuilderPreview({
        env: this.env,
        sandboxId: job.sandboxId,
        snapshotKey: job.snapshotKey,
        previewBasePath: previewPath(job.previewId, job.accessToken),
      });
      if (!this.isCurrentPreviewJob(job.previewId)) {
        await retireBuilderPreview(this.env, job.previewId, 'cancelled');
        return;
      }
      const readyAt = Date.now();
      const expiresAt = readyAt + BUILDER_PREVIEW_TTL_MS;
      await markPreviewReady(this.env.DB, job.previewId, readyAt, expiresAt);
      await this.env.APP_STORAGE.delete(job.snapshotKey).catch(() => undefined);
      const success: BuilderPreviewSuccess = {
        id: job.previewId,
        url: previewPath(job.previewId, job.accessToken),
        workspaceRevision: job.workspaceRevision,
        snapshotRevision: job.snapshotRevision,
        readyAt: new Date(readyAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      };
      const previous = this.currentPreviewState().lastSuccessful;
      const currentRevision = this.workspace.getState().revision;
      this.setPreviewState({
        status: 'ready',
        pendingId: null,
        workspaceRevision: job.workspaceRevision,
        currentWorkspaceRevision: currentRevision,
        stale: currentRevision !== job.workspaceRevision,
        attempt: this.currentPreviewState().attempt,
        requestedAt: new Date(job.requestedAt).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        updatedAt: new Date(readyAt).toISOString(),
        error: null,
        active: success,
        lastSuccessful: success,
      });
      this.recordPreviewJob(job, 'ready');
      if (previous && previous.id !== success.id) {
        await retireBuilderPreview(this.env, previous.id, 'expired').catch((error) =>
          logger.warn('Unable to retire the superseded remote preview', { error }),
        );
        this.ctx.storage.sql.exec(`DELETE FROM builder_preview_jobs WHERE id = ?`, previous.id);
      }
    } catch (error) {
      await releasePreviewBuildAdmission(this.env.DB, job.previewId).catch(() => undefined);
      await retireBuilderPreview(this.env, job.previewId, 'failed').catch(() => undefined);
      await this.failPreviewJob(
        job,
        (error instanceof Error ? error.message : 'The isolated remote preview build failed.').slice(-4_000),
      );
    }
  }

  private async failPreviewJob(job: PreviewBuildJob, error: string): Promise<void> {
    await this.env.APP_STORAGE.delete(job.snapshotKey).catch(() => undefined);
    if (!this.isCurrentPreviewJob(job.previewId)) {
      return;
    }
    const current = this.currentPreviewState();
    this.setPreviewState(failedBuilderPreviewState(current, this.workspace.getState().revision, error));
    this.recordPreviewJob(job, 'failed');
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
      stale: Boolean(successful) && successful!.workspaceRevision !== revision,
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

  private recordPreviewJob(
    job: PreviewBuildJob,
    status: 'queued' | 'building' | 'ready' | 'failed' | 'cancelled',
  ): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO builder_preview_jobs
        (id, sandbox_id, snapshot_key, workspace_revision, snapshot_revision, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
      job.previewId,
      job.sandboxId,
      job.snapshotKey,
      job.workspaceRevision,
      job.snapshotRevision,
      status,
      job.requestedAt,
      now,
    );
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
      updatedAt: finishedTurn.updatedAt,
    });
    this.turnStore.record(finishedTurn);
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

function parsePreviewBuildJob(value: unknown): PreviewBuildJob | null {
  if (!isRecord(value)) {
    return null;
  }
  const stringKeys = [
    'previewId',
    'sandboxId',
    'snapshotKey',
    'snapshotRevision',
    'ownerId',
    'chatInitialId',
    'agentName',
    'accessToken',
  ] as const;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createPreviewAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
