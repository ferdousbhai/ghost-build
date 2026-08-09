import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelCost,
  OpenAICompletionsCompat,
  FetchFunction,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamFunction,
} from '@earendil-works/pi-ai';
import { stream as openaiCompletionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import { getWorkersAiModel, isWorkersAiModelId, type WorkersAiRuntimeModelId } from '~/lib/workers-ai-model';

// Mirrors cloudflare-os/packages/workshop-backend/src/ai-models.ts — adapted for ghost-build's
// Workers-AI-only catalog. Importing pi's other provider implementations would bundle their
// Node-only SDKs into each user-owned runtime even though Ghostbuild can never route to them.

type GhostbuildModelConfig = {
  provider: 'cloudflare';
  model: WorkersAiRuntimeModelId;
  apiToken?: string;
  apiUrl?: string;
};

export type ModelStreamOptions = SimpleStreamOptions & {
  thinking?: boolean;
};

export type ModelHandle = {
  model: Model<Api>;
  stream: (model: Model<Api>, context: Context, options?: ModelStreamOptions) => AssistantMessageEventStream;
  lastResponse?: { status: number; aiGatewayLogId?: string };
};

const WORKERS_AI_STREAM = openaiCompletionsStream as StreamFunction<Api, SimpleStreamOptions>;

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function catalogModel(modelId: string): Model<Api> | undefined {
  return (CLOUDFLARE_WORKERS_AI_MODELS as Record<string, Model<Api>>)[modelId];
}

function modelTokenWindow(config: GhostbuildModelConfig, catalog: Model<Api> | undefined) {
  const model = isWorkersAiModelId(config.model) ? getWorkersAiModel(config.model) : undefined;
  return {
    contextWindow: model?.contextTokens ?? catalog?.contextWindow ?? 128_000,
    maxTokens: MODEL_MAX_OUTPUT_TOKENS,
  };
}

function workersAiCompat(catalog: Model<Api> | undefined): OpenAICompletionsCompat {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsLongCacheRetention: false,
    ...(catalog?.compat as OpenAICompletionsCompat | undefined),
    sendSessionAffinityHeaders: true,
  };
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  if (headers[name] !== undefined) {
    return headers[name];
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

type HandleArgs = {
  model: Model<Api>;
  apiKey?: string;
  fetch?: FetchFunction;
  headers?: ProviderHeaders;
  sessionAffinity?: string;
};

function makeHandle(args: HandleArgs): ModelHandle {
  if (args.model.api !== 'openai-completions') {
    throw new Error(`Workers AI requires the OpenAI Completions protocol; received "${args.model.api}".`);
  }

  const handle: ModelHandle = {
    model: args.model,
    stream: (model, context, options = {}) => {
      recordPiStage('stream_created', model.id);
      handle.lastResponse = undefined;
      const streamOptions = { ...options };
      delete streamOptions.thinking;
      const headers: ProviderHeaders = { ...args.headers, ...streamOptions.headers };
      const merged: SimpleStreamOptions = {
        ...streamOptions,
        ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
        ...(args.fetch !== undefined ? { fetch: args.fetch } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        sessionId: streamOptions.sessionId ?? args.sessionAffinity,
        onResponse: async (response, responseModel) => {
          handle.lastResponse = {
            status: response.status,
            aiGatewayLogId: getHeader(response.headers, 'cf-aig-log-id'),
          };
          await streamOptions.onResponse?.(response, responseModel);
        },
      };
      return WORKERS_AI_STREAM(model, context, merged);
    },
  };
  return handle;
}

export function getPiModel(
  accountCredentials: { accountId: string; apiKey: string } | { binding: Ai },
  modelId: WorkersAiRuntimeModelId,
  settings?: { sessionAffinity?: string },
): ModelHandle {
  const config: GhostbuildModelConfig = { provider: 'cloudflare', model: modelId };
  const catalog = catalogModel(config.model);
  const win = modelTokenWindow(config, catalog);

  // Ghost-build historically routes Workers AI through the Workers AI gateway/binding.
  // For pi, speak Workers AI's OpenAI-compat endpoint; auth is via account credentials / binding.
  // Direct REST shape mirrors cloudflare-os getModelDirect for cloudflare provider.
  if ('binding' in accountCredentials) {
    const model: Model<Api> = {
      id: config.model,
      name: catalog?.name ?? config.model,
      api: 'openai-completions',
      provider: 'cloudflare-workers-ai',
      baseUrl: 'https://workers-ai-binding.invalid/v1',
      reasoning: catalog?.reasoning ?? false,
      input: catalog?.input ?? ['text'],
      cost: catalog?.cost ?? ZERO_COST,
      ...win,
      compat: workersAiCompat(catalog),
    };
    return makeHandle({
      model,
      // pi's OpenAI-compatible serializer requires a non-empty key before calling custom fetch.
      // The binding fetch below never forwards this local sentinel or any request headers.
      apiKey: 'workers-ai-binding',
      fetch: createWorkersAiBindingFetch(accountCredentials.binding, config.model),
      sessionAffinity: settings?.sessionAffinity,
    });
  }

  const model: Model<Api> = {
    id: config.model,
    name: catalog?.name ?? config.model,
    api: 'openai-completions',
    provider: 'cloudflare-workers-ai',
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountCredentials.accountId}/ai/v1`,
    reasoning: catalog?.reasoning ?? false,
    input: catalog?.input ?? ['text'],
    cost: catalog?.cost ?? ZERO_COST,
    ...win,
    compat: workersAiCompat(catalog),
  };
  return makeHandle({
    model,
    apiKey: accountCredentials.apiKey,
    sessionAffinity: settings?.sessionAffinity,
  });
}

function createWorkersAiBindingFetch(binding: Ai, modelId: WorkersAiRuntimeModelId): FetchFunction {
  return async (input, init) => {
    recordPiStage('binding_fetch_enter', modelId);
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const payload = (await request.json()) as Record<string, unknown>;
    // The model is the first binding argument; keeping it out of inputs matches env.AI.run().
    delete payload.model;
    const rawBinding = binding as unknown as {
      run: (
        model: string,
        inputs: Record<string, unknown>,
        options: { returnRawResponse: true; signal: AbortSignal },
      ) => Promise<Response>;
    };
    recordPiStage('binding_run_start', modelId);
    const response = await rawBinding.run(modelId, payload, {
      returnRawResponse: true,
      signal: request.signal,
    });
    recordPiStage('binding_run_response', modelId, response.status);
    return response;
  };
}

function recordPiStage(stage: string, modelId: string, status?: number): void {
  console.info({ event: 'ghostbuild_pi_stage', stage, modelId, ...(status === undefined ? {} : { status }) });
}
