import { ApolloClient, createHttpLink, from, InMemoryCache, NormalizedCacheObject } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import fetch from 'cross-fetch'
import { AccessTokenResponse, ClientCredentialsConfig, getClientCredentialsToken } from '@makerxstudio/node-common'

export * from '@apollo/client/core'

const bearerTokenLink = (accessToken?: string) =>
  setContext(() => {
    if (!accessToken) return undefined
    return {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
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
    fetch: fetch as unknown as WindowOrWorkerGlobalScope['fetch'],
  })

export const createTestClient = (url: string, accessToken?: string): ApolloClient<NormalizedCacheObject> =>
  new ApolloClient({
    link: from([bearerTokenLink(accessToken), httpLink(url)]),
    cache: new InMemoryCache(),
    defaultOptions: {
      query: {
        errorPolicy: 'all',
      },
    },
  })

export const createTestClientWithClientCredentials = (
  url: string,
  clientCredentialsConfig: ClientCredentialsConfig
): ApolloClient<NormalizedCacheObject> =>
  new ApolloClient({
    link: from([clientCredentialsLink(clientCredentialsConfig), httpLink(url)]),
    cache: new InMemoryCache(),
    defaultOptions: {
      query: {
        errorPolicy: 'all',
      },
    },
  })
