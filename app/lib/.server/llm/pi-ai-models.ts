import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelCost,
  OpenAICompletionsCompat,
  AnthropicMessagesCompat,
  FetchFunction,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamFunction,
} from '@earendil-works/pi-ai';
import { stream as anthropicMessagesStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { stream as googleGenerativeAiStream } from '@earendil-works/pi-ai/api/google-generative-ai';
import { stream as openaiCompletionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as openaiResponsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import { getWorkersAiModel, isWorkersAiModelId, type WorkersAiRuntimeModelId } from '~/lib/workers-ai-model';

// Mirrors cloudflare-os/packages/workshop-backend/src/ai-models.ts — adapted for ghost-build's
// Workers-AI-only catalog. Multi-provider catalogs are kept for pi's type parity, but ghost-build
// only routes Workers AI via its gateway account binding at runtime.

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

const API_STREAMS: Record<string, StreamFunction<Api, SimpleStreamOptions>> = {
  'anthropic-messages': anthropicMessagesStream as StreamFunction<Api, SimpleStreamOptions>,
  'openai-responses': openaiResponsesStream as StreamFunction<Api, SimpleStreamOptions>,
  'openai-completions': openaiCompletionsStream as StreamFunction<Api, SimpleStreamOptions>,
  'google-generative-ai': googleGenerativeAiStream as StreamFunction<Api, SimpleStreamOptions>,
};

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function catalogModel(provider: string, modelId: string): Model<Api> | undefined {
  switch (provider) {
    case 'anthropic':
      return (ANTHROPIC_MODELS as Record<string, Model<Api>>)[modelId];
    case 'openai':
      return (OPENAI_MODELS as Record<string, Model<Api>>)[modelId];
    case 'google':
      return (GOOGLE_MODELS as Record<string, Model<Api>>)[modelId];
    case 'cloudflare':
      return (CLOUDFLARE_WORKERS_AI_MODELS as Record<string, Model<Api>>)[modelId];
    default:
      return undefined;
  }
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
  const streamFn = API_STREAMS[args.model.api];
  if (!streamFn) {
    throw new Error(`Unsupported model API "${args.model.api}".`);
  }

  const anthropicCompat = args.model.compat as AnthropicMessagesCompat | undefined;
  const apiExtras: Record<string, unknown> =
    args.model.api === 'anthropic-messages'
      ? anthropicCompat?.forceAdaptiveThinking === true
        ? { thinkingEnabled: true }
        : {}
      : args.model.api === 'openai-responses'
        ? { reasoningEffort: 'medium' }
        : {};

  const handle: ModelHandle = {
    model: args.model,
    stream: (model, context, { thinking = true, ...options } = {}) => {
      handle.lastResponse = undefined;
      const headers: ProviderHeaders = { ...args.headers, ...options.headers };
      const merged: SimpleStreamOptions = {
        ...(thinking ? apiExtras : args.model.api === 'anthropic-messages' ? { thinkingEnabled: false } : {}),
        ...options,
        ...(args.apiKey !== undefined ? { apiKey: args.apiKey } : {}),
        ...(args.fetch !== undefined ? { fetch: args.fetch } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        sessionId: options.sessionId ?? args.sessionAffinity,
        onResponse: async (response, responseModel) => {
          handle.lastResponse = {
            status: response.status,
            aiGatewayLogId: getHeader(response.headers, 'cf-aig-log-id'),
          };
          await options.onResponse?.(response, responseModel);
        },
      };
      return streamFn(model, context, merged);
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
  const catalog = catalogModel(config.provider, config.model);
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
    return rawBinding.run(modelId, payload, {
      returnRawResponse: true,
      signal: request.signal,
    });
  };
}
