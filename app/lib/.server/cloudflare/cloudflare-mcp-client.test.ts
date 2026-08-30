import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLOUDFLARE_MCP_CALL_TIMEOUT_MS,
  CLOUDFLARE_MCP_CONNECT_TIMEOUT_MS,
  CLOUDFLARE_MCP_ENDPOINT,
  CLOUDFLARE_MCP_EXPECTED_TOOL_CONTRACT,
  CLOUDFLARE_MCP_LIST_TIMEOUT_MS,
  CLOUDFLARE_MCP_MAX_NORMALIZED_CONTENT_BYTES,
  CLOUDFLARE_MCP_MAX_REQUEST_BYTES,
  CLOUDFLARE_MCP_MAX_RESPONSE_BYTES,
  CLOUDFLARE_MCP_MAX_TOOL_INPUT_BYTES,
  CLOUDFLARE_MCP_OVERALL_TIMEOUT_MS,
  CLOUDFLARE_MCP_PROTOCOL_VERSION,
  CLOUDFLARE_MCP_PROVIDER_TRUNCATION_MARKER,
  CloudflareMcpClient,
  CloudflareMcpCompatibilityError,
  CloudflareMcpError,
  type CloudflareMcpClientDependencies,
  type CloudflareMcpDocsInvocation,
  type CloudflareMcpExecuteInvocation,
  type CloudflareMcpInvocation,
  type CloudflareMcpOperationContext,
  type CloudflareMcpOutcome,
  type CloudflareMcpSearchInvocation,
} from './cloudflare-mcp-client';

interface ToolFixtureProperty {
  type: string;
}

interface ToolFixtureProperties {
  query?: ToolFixtureProperty;
  code?: ToolFixtureProperty;
  account_id?: ToolFixtureProperty;
  extra?: ToolFixtureProperty;
}

interface ToolFixture {
  name: string;
  inputSchema: {
    type: 'object';
    properties: ToolFixtureProperties;
    required: readonly string[];
  };
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const expectedTools = [
  {
    name: 'docs',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'search',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
  {
    name: 'execute',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, account_id: { type: 'string' } },
      required: ['code'],
    },
  },
] as const satisfies readonly ToolFixture[];

const sentMessageSchema = z.looseObject({
  method: z.enum(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']),
  params: z
    .looseObject({
      name: z.enum(['docs', 'search', 'execute']).optional(),
      arguments: z
        .looseObject({
          query: z.string().optional(),
          code: z.string().optional(),
          account_id: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CloudflareMcpClient', () => {
  it('discovers the fixed contract and calls docs, search, and execute with bounded metadata', async () => {
    const accessToken = 'cloudflare-access-token-value';
    const request = vi.fn<typeof fetch>();
    const resolveAccessToken = vi.fn(async () => accessToken);
    const recordCompatibilityMetric =
      vi.fn<NonNullable<CloudflareMcpClientDependencies['recordCompatibilityMetric']>>();
    const client = new CloudflareMcpClient({ resolveAccessToken, request, recordCompatibilityMetric });

    queueDiscovery(request, 'discover-1');
    const discovery = await client.discover(operationContext('discover-1'));
    expect(discovery).toMatchObject({
      status: 'compatible',
      tools: ['docs', 'search', 'execute'],
      metadata: { operation: 'discovery', statusClass: '2xx', requestId: 'list-ray' },
    });
    expect(CLOUDFLARE_MCP_EXPECTED_TOOL_CONTRACT).toHaveLength(3);

    const docs = docsInvocation('docs-1');
    queueSuccessfulCall(request, docs.invocationId, 'documentation result');
    const docsOutcome = await client.invoke(docs);
    expect(docsOutcome).toMatchObject({
      status: 'success',
      content: [{ type: 'text', text: 'documentation result' }],
      metadata: { operation: 'docs', statusClass: '2xx', requestId: 'call-ray' },
    });

    const search = searchInvocation('search-1');
    queueSuccessfulCall(request, search.invocationId, 'search result');
    const searchOutcome = await client.invoke(search);
    expect(searchOutcome).toMatchObject({ status: 'success', content: [{ text: 'search result' }] });

    const execute = executeInvocation('execute-1');
    queueSuccessfulCall(request, execute.invocationId, 'execute result');
    const executeOutcome = await client.invoke(execute);
    expect(executeOutcome).toMatchObject({ status: 'success', content: [{ text: 'execute result' }] });
    expect(outcomeStatus(executeOutcome)).toBe('success');
    expect(invocationToolName(execute)).toBe('execute');

    expect(resolveAccessToken).toHaveBeenCalledTimes(4);
    expect(recordCompatibilityMetric).toHaveBeenCalledTimes(4);
    for (const [metric] of recordCompatibilityMetric.mock.calls) {
      expect(metric).toEqual({ provider: 'cloudflare-official-mcp', status: 'compatible' });
      expect(Object.keys(metric)).toEqual(['provider', 'status']);
    }
    for (const [url, init] of request.mock.calls) {
      expect(String(url)).toBe(CLOUDFLARE_MCP_ENDPOINT);
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
      const headers = new Headers(init?.headers);
      expect([...headers.keys()]).toEqual(['accept', 'authorization', 'content-type', 'mcp-protocol-version']);
      expect(headers.get('accept')).toBe('application/json, text/event-stream');
      expect(headers.get('authorization')).toBe(`Bearer ${accessToken}`);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('mcp-protocol-version')).toBe(CLOUDFLARE_MCP_PROTOCOL_VERSION);
    }

    const calls = sentMessages(request).filter((message) => message.method === 'tools/call');
    expect(calls.map((message) => message.params)).toEqual([
      { name: 'docs', arguments: { query: 'How does R2 work?' } },
      { name: 'search', arguments: { code: 'async () => []' } },
      {
        name: 'execute',
        arguments: {
          code: 'async () => cloudflare.request({ method: "GET", path: "/accounts" })',
          account_id: accountId,
        },
      },
    ]);
  });

  it('fails closed with a typed compatibility error when the catalog or schema drifts', async () => {
    const missingToolRequest = vi.fn<typeof fetch>();
    const recordCompatibilityMetric =
      vi.fn<NonNullable<CloudflareMcpClientDependencies['recordCompatibilityMetric']>>();
    const client = new CloudflareMcpClient({
      resolveAccessToken: async () => 'access-token',
      request: missingToolRequest,
      recordCompatibilityMetric,
    });
    queueDiscovery(missingToolRequest, 'drift-missing', expectedTools.slice(0, 2));
    await expect(client.discover(operationContext('drift-missing'))).rejects.toBeInstanceOf(
      CloudflareMcpCompatibilityError,
    );
    expect(recordCompatibilityMetric).toHaveBeenCalledWith({
      provider: 'cloudflare-official-mcp',
      status: 'incompatible',
    });

    const schemaDriftRequest = vi.fn<typeof fetch>();
    const schemaDriftClient = createClient(schemaDriftRequest);
    const driftedTools = [
      expectedTools[0],
      expectedTools[1],
      {
        name: 'execute',
        inputSchema: {
          type: 'object',
          properties: { code: { type: 'string' }, account_id: { type: 'string' }, extra: { type: 'string' } },
          required: ['code', 'extra'],
        },
      },
    ] as const satisfies readonly ToolFixture[];
    queueDiscovery(schemaDriftRequest, 'drift-schema', driftedTools);
    await expect(schemaDriftClient.discover(operationContext('drift-schema'))).rejects.toBeInstanceOf(
      CloudflareMcpCompatibilityError,
    );
  });

  it('rejects stateful sessions and non-JSON transport drift instead of auto-detecting a fallback', async () => {
    const sessionRequest = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          jsonrpc: '2.0',
          id: 'session-drift:initialize',
          result: {
            protocolVersion: CLOUDFLARE_MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'cloudflare-api', version: '1.0.0' },
          },
        },
        { headers: { 'mcp-session-id': 'unexpected-session' } },
      ),
    );
    await expect(createClient(sessionRequest).discover(operationContext('session-drift'))).rejects.toBeInstanceOf(
      CloudflareMcpCompatibilityError,
    );

    const streamingRequest = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response('event: message\ndata: {"jsonrpc":"2.0"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    await expect(createClient(streamingRequest).invoke(docsInvocation('stream-drift'))).resolves.toMatchObject({
      status: 'failure',
      error: { code: 'malformed_response' },
    });
    expect(streamingRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps bearer values transient and redacts bearer-shaped and exact-token output', async () => {
    const accessToken = 'sensitive-token-value-123456789';
    const request = vi.fn<typeof fetch>();
    const client = new CloudflareMcpClient({ resolveAccessToken: async () => accessToken, request });
    const invocation = docsInvocation('redaction-1');
    queueSuccessfulCall(
      request,
      invocation.invocationId,
      `Bearer ${accessToken} raw=${accessToken} Bearer another-token-value-987654321`,
    );

    const outcome = await client.invoke(invocation);
    expect(JSON.stringify(client)).toBe('{}');
    expect(JSON.stringify(outcome)).not.toContain(accessToken);
    expect(JSON.stringify(outcome)).not.toContain('another-token-value-987654321');
    expect(outcome).toMatchObject({ status: 'success', content: [{ text: '[REDACTED] raw=[REDACTED] [REDACTED]' }] });

    const rejectedClient = new CloudflareMcpClient({
      resolveAccessToken: async () => {
        throw new Error(`credential failed with Bearer ${accessToken}`);
      },
      request: vi.fn<typeof fetch>(),
    });
    try {
      await rejectedClient.discover(operationContext('redaction-error'));
      throw new Error('Expected credential resolution to fail.');
    } catch (cause) {
      expect(cause).toBeInstanceOf(CloudflareMcpError);
      expect(String(cause)).not.toContain(accessToken);
    }
  });

  it('rejects redirects and never follows a provider-supplied URL', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://attacker.example/mcp' } }),
      );
    const client = createClient(request);

    await expect(client.discover(operationContext('redirect-1'))).rejects.toMatchObject({
      code: 'redirect_rejected',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toBe(CLOUDFLARE_MCP_ENDPOINT);
    expect(request.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('rejects a tool-supplied account selection instead of overriding the fixed account boundary', async () => {
    const request = vi.fn<typeof fetch>();
    const client = createClient(request);
    const untrustedInput = { code: 'async () => []', account_id: 'different-account' };
    const invocation = {
      ...operationContext('account-override'),
      toolName: 'execute' as const,
      toolInput: untrustedInput,
    };

    await expect(client.invoke(invocation)).rejects.toMatchObject({ code: 'invalid_invocation' });
    expect(request).not.toHaveBeenCalled();
  });

  it('enforces input and response caps and preserves the provider truncation marker', async () => {
    const oversizedInputRequest = vi.fn<typeof fetch>();
    const oversizedInputClient = createClient(oversizedInputRequest);
    const oversizedInvocation = searchInvocation(
      'oversized-input',
      'x'.repeat(CLOUDFLARE_MCP_MAX_TOOL_INPUT_BYTES + 1),
    );
    await expect(oversizedInputClient.invoke(oversizedInvocation)).rejects.toMatchObject({ code: 'request_too_large' });
    expect(oversizedInputRequest).not.toHaveBeenCalled();

    const oversizedResponseRequest = vi.fn<typeof fetch>();
    const oversizedResponseClient = createClient(oversizedResponseRequest);
    const responseInvocation = searchInvocation('oversized-response');
    queueDiscovery(oversizedResponseRequest, responseInvocation.invocationId);
    oversizedResponseRequest.mockResolvedValueOnce(
      new Response('x'.repeat(CLOUDFLARE_MCP_MAX_RESPONSE_BYTES + 1), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(oversizedResponseClient.invoke(responseInvocation)).resolves.toMatchObject({
      status: 'failure',
      error: { code: 'response_too_large' },
    });

    const truncationRequest = vi.fn<typeof fetch>();
    const truncationClient = createClient(truncationRequest);
    const truncationInvocation = docsInvocation('provider-truncation');
    const providerText = `${'a'.repeat(CLOUDFLARE_MCP_MAX_NORMALIZED_CONTENT_BYTES + 512)}\n${CLOUDFLARE_MCP_PROVIDER_TRUNCATION_MARKER}`;
    queueSuccessfulCall(truncationRequest, truncationInvocation.invocationId, providerText);
    const outcome = await truncationClient.invoke(truncationInvocation);
    expect(outcome).toMatchObject({
      status: 'success',
      metadata: { truncated: true, providerTruncated: true, clientTruncated: true },
    });
    if (outcome.status !== 'success') {
      throw new Error('Expected a successful truncated response.');
    }
    expect(outcome.content[0]?.text.endsWith(CLOUDFLARE_MCP_PROVIDER_TRUNCATION_MARKER)).toBe(true);
    expect(new TextEncoder().encode(outcome.content[0]?.text).byteLength).toBeLessThanOrEqual(
      CLOUDFLARE_MCP_MAX_NORMALIZED_CONTENT_BYTES,
    );
  });

  it('forces one credential refresh after a pre-execution 401 and never refreshes twice', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }));
    const resolveAccessToken = vi
      .fn<CloudflareMcpClientDependencies['resolveAccessToken']>()
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValueOnce('fresh-token');
    const client = new CloudflareMcpClient({ resolveAccessToken, request });
    const invocation = docsInvocation('refresh-success');
    queueSuccessfulCall(request, invocation.invocationId, 'refreshed result');

    await expect(client.invoke(invocation)).resolves.toMatchObject({ status: 'success' });
    expect(resolveAccessToken).toHaveBeenNthCalledWith(1);
    expect(resolveAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer expired-token');
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer fresh-token');

    const callRejectedRequest = vi.fn<typeof fetch>();
    const callRejectedInvocation = docsInvocation('call-refresh');
    queueDiscovery(callRejectedRequest, callRejectedInvocation.invocationId);
    callRejectedRequest.mockResolvedValueOnce(new Response(null, { status: 401 }));
    queueSuccessfulCall(callRejectedRequest, callRejectedInvocation.invocationId, 'fresh call result');
    const callRejectedResolver = vi
      .fn<CloudflareMcpClientDependencies['resolveAccessToken']>()
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValueOnce('fresh-token');
    const callRejectedClient = new CloudflareMcpClient({
      resolveAccessToken: callRejectedResolver,
      request: callRejectedRequest,
    });
    await expect(callRejectedClient.invoke(callRejectedInvocation)).resolves.toMatchObject({
      status: 'success',
      content: [{ text: 'fresh call result' }],
    });
    expect(callRejectedResolver).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(callRejectedRequest).toHaveBeenCalledTimes(8);
    for (const [, init] of callRejectedRequest.mock.calls.slice(0, 4)) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer expired-token');
    }
    for (const [, init] of callRejectedRequest.mock.calls.slice(4)) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fresh-token');
    }

    const rejectedRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const rejectedResolver = vi
      .fn<CloudflareMcpClientDependencies['resolveAccessToken']>()
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValueOnce('also-rejected-token');
    const rejectedClient = new CloudflareMcpClient({ resolveAccessToken: rejectedResolver, request: rejectedRequest });
    await expect(rejectedClient.invoke(docsInvocation('refresh-rejected'))).resolves.toMatchObject({
      status: 'failure',
      error: { code: 'authentication_failed' },
      metadata: { httpStatus: 401, statusClass: '4xx' },
    });
    expect(rejectedResolver).toHaveBeenCalledTimes(2);
    expect(rejectedRequest).toHaveBeenCalledTimes(2);
  });

  it('does not retry an execute call after a timeout, disconnect, or 5xx and reports indeterminate', async () => {
    const timeoutRequest = vi.fn<typeof fetch>();
    const timeoutInvocation = executeInvocation('timeout-1');
    queueDiscovery(timeoutRequest, timeoutInvocation.invocationId);
    timeoutRequest.mockRejectedValueOnce(new DOMException('call timed out', 'TimeoutError'));
    const timeoutResolver = vi.fn(async () => 'access-token');
    const timeoutClient = new CloudflareMcpClient({ resolveAccessToken: timeoutResolver, request: timeoutRequest });
    await expect(timeoutClient.invoke(timeoutInvocation)).resolves.toMatchObject({
      status: 'indeterminate',
      error: { code: 'timeout', reconcileBeforeRetry: true },
    });
    expect(timeoutRequest).toHaveBeenCalledTimes(4);
    expect(timeoutResolver).toHaveBeenCalledTimes(1);

    const disconnectedRequest = vi.fn<typeof fetch>();
    const disconnectedInvocation = executeInvocation('disconnect-1');
    queueDiscovery(disconnectedRequest, disconnectedInvocation.invocationId);
    disconnectedRequest.mockRejectedValueOnce(new Error('connection closed during call'));
    const disconnectedResolver = vi.fn(async () => 'access-token');
    const disconnectedClient = new CloudflareMcpClient({
      resolveAccessToken: disconnectedResolver,
      request: disconnectedRequest,
    });
    await expect(disconnectedClient.invoke(disconnectedInvocation)).resolves.toMatchObject({
      status: 'indeterminate',
      error: { code: 'transport_failure', reconcileBeforeRetry: true },
    });
    expect(disconnectedRequest).toHaveBeenCalledTimes(4);
    expect(disconnectedResolver).toHaveBeenCalledTimes(1);

    const serverErrorRequest = vi.fn<typeof fetch>();
    const serverErrorInvocation = executeInvocation('server-error-1');
    queueDiscovery(serverErrorRequest, serverErrorInvocation.invocationId);
    serverErrorRequest.mockResolvedValueOnce(new Response('provider unavailable', { status: 503 }));
    const serverErrorResolver = vi.fn(async () => 'access-token');
    const serverErrorClient = new CloudflareMcpClient({
      resolveAccessToken: serverErrorResolver,
      request: serverErrorRequest,
    });
    await expect(serverErrorClient.invoke(serverErrorInvocation)).resolves.toMatchObject({
      status: 'indeterminate',
      error: { code: 'provider_failure', reconcileBeforeRetry: true },
      metadata: { statusClass: '5xx', httpStatus: 503 },
    });
    expect(serverErrorRequest).toHaveBeenCalledTimes(4);
    expect(serverErrorResolver).toHaveBeenCalledTimes(1);
  });

  it('surfaces insufficient_scope as its own outcome', async () => {
    const request = vi.fn<typeof fetch>();
    const invocation = executeInvocation('scope-1');
    queueDiscovery(request, invocation.invocationId);
    request.mockResolvedValueOnce(
      Response.json(
        {
          jsonrpc: '2.0',
          id: `${invocation.invocationId}:tools-call`,
          error: { code: -32001, message: 'insufficient_scope: Workers Scripts Write is required' },
        },
        { headers: { 'cf-ray': 'scope-ray' } },
      ),
    );
    const client = createClient(request);

    await expect(client.invoke(invocation)).resolves.toMatchObject({
      status: 'insufficient_scope',
      metadata: { requestId: 'scope-ray', statusClass: '2xx' },
    });
    expect(request).toHaveBeenCalledTimes(4);

    const challengeRequest = vi.fn<typeof fetch>();
    const challengeInvocation = executeInvocation('scope-challenge');
    queueDiscovery(challengeRequest, challengeInvocation.invocationId);
    challengeRequest.mockResolvedValueOnce(
      new Response(null, {
        status: 403,
        headers: { 'www-authenticate': 'Bearer error="insufficient_scope"', 'cf-ray': 'challenge-ray' },
      }),
    );
    await expect(createClient(challengeRequest).invoke(challengeInvocation)).resolves.toMatchObject({
      status: 'insufficient_scope',
      metadata: { requestId: 'challenge-ray', statusClass: '4xx' },
    });
  });

  it('rejects malformed JSON-RPC call content without retrying a read', async () => {
    const request = vi.fn<typeof fetch>();
    const invocation = searchInvocation('malformed-1');
    queueDiscovery(request, invocation.invocationId);
    request.mockResolvedValueOnce(
      new Response('{"not":"json-rpc"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const resolveAccessToken = vi.fn(async () => 'access-token');
    const client = new CloudflareMcpClient({ resolveAccessToken, request });

    await expect(client.invoke(invocation)).resolves.toMatchObject({
      status: 'failure',
      error: { code: 'malformed_response' },
    });
    expect(request).toHaveBeenCalledTimes(4);
    expect(resolveAccessToken).toHaveBeenCalledTimes(1);
  });

  it('publishes named phase and aggregate limits', () => {
    expect(
      [
        CLOUDFLARE_MCP_CONNECT_TIMEOUT_MS,
        CLOUDFLARE_MCP_LIST_TIMEOUT_MS,
        CLOUDFLARE_MCP_CALL_TIMEOUT_MS,
        CLOUDFLARE_MCP_OVERALL_TIMEOUT_MS,
      ].every((timeout) => timeout > 0),
    ).toBe(true);
    expect(CLOUDFLARE_MCP_MAX_REQUEST_BYTES).toBeGreaterThan(CLOUDFLARE_MCP_MAX_TOOL_INPUT_BYTES);
  });
});

const accountId = '0123456789abcdef0123456789abcdef';

function operationContext(invocationId: string): CloudflareMcpOperationContext {
  return {
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 3,
    accountId,
    signal: new AbortController().signal,
    invocationId,
  };
}

function docsInvocation(invocationId: string): CloudflareMcpDocsInvocation {
  return { ...operationContext(invocationId), toolName: 'docs', toolInput: { query: 'How does R2 work?' } };
}

function searchInvocation(invocationId: string, code = 'async () => []'): CloudflareMcpSearchInvocation {
  return { ...operationContext(invocationId), toolName: 'search', toolInput: { code } };
}

function executeInvocation(invocationId: string): CloudflareMcpExecuteInvocation {
  return {
    ...operationContext(invocationId),
    toolName: 'execute',
    toolInput: { code: 'async () => cloudflare.request({ method: "GET", path: "/accounts" })' },
  };
}

function createClient(request: FetchMock): CloudflareMcpClient {
  return new CloudflareMcpClient({ resolveAccessToken: async () => 'access-token', request });
}

function queueDiscovery(request: FetchMock, invocationId: string, tools: readonly ToolFixture[] = expectedTools): void {
  request
    .mockResolvedValueOnce(
      Response.json({
        jsonrpc: '2.0',
        id: `${invocationId}:initialize`,
        result: {
          protocolVersion: CLOUDFLARE_MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cloudflare-api', version: '1.0.0' },
        },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(
      Response.json(
        { jsonrpc: '2.0', id: `${invocationId}:tools-list`, result: { tools } },
        { headers: { 'cf-ray': 'list-ray' } },
      ),
    );
}

function queueSuccessfulCall(request: FetchMock, invocationId: string, text: string): void {
  queueDiscovery(request, invocationId);
  request.mockResolvedValueOnce(
    Response.json(
      {
        jsonrpc: '2.0',
        id: `${invocationId}:tools-call`,
        result: { content: [{ type: 'text', text }] },
      },
      { headers: { 'cf-ray': 'call-ray' } },
    ),
  );
}

function sentMessages(request: FetchMock) {
  return request.mock.calls.map(([, init]) => sentMessageSchema.parse(JSON.parse(String(init?.body))));
}

function invocationToolName(invocation: CloudflareMcpInvocation): string {
  return invocation.toolName;
}

function outcomeStatus(outcome: CloudflareMcpOutcome): string {
  return outcome.status;
}
