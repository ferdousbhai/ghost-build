export type CloudflareConnectionStatus = {
  status: 'connected' | 'missing-token' | 'invalid-token' | 'error'
  accountName?: string
  accountId?: string
  permissions: Array<string>
  message: string
}

type CloudflareTokenVerifyResponse = {
  success?: boolean
  result?: {
    status?: string
    policies?: Array<{
      permission_groups?: Array<{
        name?: string
      }>
    }>
  }
  errors?: Array<{ message?: string }>
}

type CloudflareAccountsResponse = {
  success?: boolean
  result?: Array<{
    id?: string
    name?: string
  }>
}

export async function verifyCloudflareConnection(
  token = (process.env as Record<string, string | undefined>).CLOUDFLARE_API_TOKEN,
  fetcher: typeof fetch = fetch,
): Promise<CloudflareConnectionStatus> {
  if (!token) {
    return {
      status: 'missing-token',
      permissions: [],
      message: 'Set CLOUDFLARE_API_TOKEN to verify Cloudflare account access.',
    }
  }

  try {
    const verifyResponse = await fetcher(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    )
    const verify = (await verifyResponse.json()) as CloudflareTokenVerifyResponse

    if (!verifyResponse.ok || !verify.success) {
      return {
        status: 'invalid-token',
        permissions: [],
        message:
          verify.errors?.[0]?.message ||
          'Cloudflare token verification failed.',
      }
    }

    const account = await readFirstCloudflareAccount(token, fetcher)

    return {
      status: 'connected',
      accountId: account?.id,
      accountName: account?.name,
      permissions: extractPermissionNames(verify),
      message: account?.name
        ? `Connected to ${account.name}.`
        : 'Cloudflare token verified.',
    }
  } catch {
    return {
      status: 'error',
      permissions: [],
      message: 'Unable to verify Cloudflare connection.',
    }
  }
}

export function hasWorkersWritePermission(permissions: Array<string>) {
  return permissions.some((permission) => {
    const normalized = permission.toLowerCase()

    return (
      normalized.includes('workers') &&
      (normalized.includes('write') || normalized.includes('edit'))
    )
  })
}

async function readFirstCloudflareAccount(
  token: string,
  fetcher: typeof fetch,
) {
  const response = await fetcher('https://api.cloudflare.com/client/v4/accounts', {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })
  const data = (await response.json()) as CloudflareAccountsResponse

  if (!response.ok || !data.success) {
    return undefined
  }

  return data.result?.[0]
}

function extractPermissionNames(response: CloudflareTokenVerifyResponse) {
  return [
    ...new Set(
      response.result?.policies?.flatMap((policy) =>
        policy.permission_groups?.flatMap((group) =>
          group.name ? [group.name] : [],
        ) ?? [],
      ) ?? [],
    ),
  ]
}
