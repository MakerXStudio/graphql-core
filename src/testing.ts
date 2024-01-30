import type { NormalizedCacheObject } from '@apollo/client/core'
import { ApolloClient, createHttpLink, from, InMemoryCache } from '@apollo/client/core'
import type { ApolloClientOptions } from '@apollo/client/core/ApolloClient'
import { setContext } from '@apollo/client/link/context'
import type { AccessTokenResponse, ClientCredentialsConfig } from '@makerx/node-common'
import { getClientCredentialsToken } from '@makerx/node-common'

export * from '@apollo/client/core'

const bearerTokenLink = (accessToken?: string) =>
  setContext((_, { headers }) => {
    if (accessToken)
      return {
        headers: {
          ...headers,
          authorization: `Bearer ${accessToken}`,
        },
      }
    return {
      headers,
    }
  })

const clientCredentialsLink = (clientCredentialsConfig: ClientCredentialsConfig) => {
  let promise: Promise<AccessTokenResponse> | undefined
  return setContext(async () => {
    if (!promise) promise = getClientCredentialsToken(clientCredentialsConfig)
    let tokenResponse = await promise
    if (tokenResponse.isExpired) {
      promise = getClientCredentialsToken(clientCredentialsConfig)
      tokenResponse = await promise
    }
    return {
      headers: {
        authorization: `Bearer ${tokenResponse.access_token}`,
      },
    }
  })
}

const httpLink = (url: string) =>
  createHttpLink({
    uri: url,
  })

export const createTestClient = (
  url: string,
  accessToken?: string,
  options?: Partial<ApolloClientOptions<NormalizedCacheObject>>,
): ApolloClient<NormalizedCacheObject> =>
  new ApolloClient({
    link: from([bearerTokenLink(accessToken), httpLink(url)]),
    cache: new InMemoryCache(),
    defaultOptions: {
      query: {
        errorPolicy: 'all',
      },
    },
    ...options,
  })

export const createTestClientWithClientCredentials = (
  url: string,
  clientCredentialsConfig: ClientCredentialsConfig,
  options?: Partial<ApolloClientOptions<NormalizedCacheObject>>,
): ApolloClient<NormalizedCacheObject> =>
  new ApolloClient({
    link: from([clientCredentialsLink(clientCredentialsConfig), httpLink(url)]),
    cache: new InMemoryCache(),
    defaultOptions: {
      query: {
        errorPolicy: 'all',
      },
    },
    ...options,
  })
