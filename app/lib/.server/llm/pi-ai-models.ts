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
import { recordPiStage } from './pi-telemetry';

// Keep the runtime on the Workers-AI-only catalog; importing unrelated provider SDKs would
// add Node-only code to every user-owned runtime.

type GhostbuildModelConfig = {
  provider: 'cloudflare';
  model: WorkersAiRuntimeModelId;
};

export type ModelStreamOptions = SimpleStreamOptions & {
  thinking?: boolean;
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
};

export type ModelHandle = {
  model: Model<Api>;
  stream: (model: Model<Api>, context: Context, options?: ModelStreamOptions) => AssistantMessageEventStream;
  lastResponse?: { status: number; aiGatewayLogId?: string };
};

// SAFETY: `makeHandle` refuses any model whose `api` is not `openai-completions`, so every model this
// stream ever receives matches the narrower signature the OpenAI Completions adapter declares.
const WORKERS_AI_STREAM = openaiCompletionsStream as StreamFunction<Api, SimpleStreamOptions>;

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type WorkersAiCatalogModel = (typeof CLOUDFLARE_WORKERS_AI_MODELS)[keyof typeof CLOUDFLARE_WORKERS_AI_MODELS];

const WORKERS_AI_CATALOG = new Map<string, WorkersAiCatalogModel>(Object.entries(CLOUDFLARE_WORKERS_AI_MODELS));

function catalogModel(modelId: string): WorkersAiCatalogModel | undefined {
  return WORKERS_AI_CATALOG.get(modelId);
}

function modelTokenWindow(config: GhostbuildModelConfig, catalog: WorkersAiCatalogModel | undefined) {
  const model = isWorkersAiModelId(config.model) ? getWorkersAiModel(config.model) : undefined;
  return {
    contextWindow: model?.contextTokens ?? catalog?.contextWindow ?? 128_000,
    maxTokens: MODEL_MAX_OUTPUT_TOKENS,
  };
}

function workersAiCompat(catalog: WorkersAiCatalogModel | undefined): OpenAICompletionsCompat {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsLongCacheRetention: false,
    ...catalog?.compat,
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
        sessionId: streamOptions.sessionId ?? args.sessionAffinity,
        onResponse: async (response, responseModel) => {
          handle.lastResponse = {
            status: response.status,
            aiGatewayLogId: getHeader(response.headers, 'cf-aig-log-id'),
          };
          await streamOptions.onResponse?.(response, responseModel);
        },
      };
      if (args.apiKey !== undefined) {
        merged.apiKey = args.apiKey;
      }
      if (args.fetch !== undefined) {
        merged.fetch = args.fetch;
      }
      if (Object.keys(headers).length > 0) {
        merged.headers = headers;
      }
      return WORKERS_AI_STREAM(model, context, merged);
    },
  };
  return handle;
}

export function getPiModel(
  accountCredentials: { binding: Ai },
  modelId: WorkersAiRuntimeModelId,
  settings?: { sessionAffinity?: string },
): ModelHandle {
  const config: GhostbuildModelConfig = { provider: 'cloudflare', model: modelId };
  const catalog = catalogModel(config.model);
  const win = modelTokenWindow(config, catalog);
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
    // Pi's OpenAI-compatible serializer requires a non-empty key before calling custom fetch.
    // The binding adapter forwards only the reviewed session-affinity header.
    apiKey: 'workers-ai-binding',
    fetch: createWorkersAiBindingFetch(accountCredentials.binding, config.model),
    sessionAffinity: settings?.sessionAffinity,
  });
}

/** The OpenAI-compatible body Pi serialises, forwarded to the binding verbatim apart from `model`. */
type WorkersAiBindingInputs = Record<string, unknown> & { model?: string };

type WorkersAiRawRunOptions = {
  returnRawResponse: true;
  signal: AbortSignal;
  extraHeaders?: Record<string, string>;
  gateway?: { id: string; collectLog?: boolean; skipCache?: boolean };
};

type WorkersAiRawBinding = {
  run(model: string, inputs: WorkersAiBindingInputs, options: WorkersAiRawRunOptions): Promise<Response>;
};

function createWorkersAiBindingFetch(binding: Ai, modelId: WorkersAiRuntimeModelId): FetchFunction {
  return async (input, init) => {
    recordPiStage('binding_fetch_enter', modelId);
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const payload = await request.json<WorkersAiBindingInputs>();
    // The model is the first binding argument; keeping it out of inputs matches env.AI.run().
    delete payload.model;
    // SAFETY: `Ai.run` is generic over the generated `AiModelList`, which does not enumerate every
    // Workers AI model Ghostbuild can be pointed at. The binding itself accepts any model id, so the
    // raw-response entry point is reached through the non-generic contract it actually implements.
    const rawBinding = binding as WorkersAiRawBinding;
    recordPiStage('binding_run_start', modelId);
    const sessionAffinity = request.headers.get('x-session-affinity');
    const options: WorkersAiRawRunOptions = { returnRawResponse: true, signal: request.signal };
    if (isWorkersAiModelId(modelId) && getWorkersAiModel(modelId).availability === 'cloudflare-partner') {
      options.gateway = { id: 'default', collectLog: false, skipCache: true };
    }
    if (sessionAffinity) {
      options.extraHeaders = { 'x-session-affinity': sessionAffinity };
    }
    const response = await rawBinding.run(modelId, payload, options);
    recordPiStage('binding_run_response', modelId, response.status);
    return response;
  };
}
