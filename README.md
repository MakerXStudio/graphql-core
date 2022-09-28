# GraphQL Core

A set of core GraphQL utilities that MakerX uses to build GraphQL APIs.

These utilities avoid dependencies on any particular GraphQL server or logging implementation, providing a standard set of behaviours to use across varying implementations.

Note: See explaination on \*Express peer dependency below.

## Context

`createContextFactory` returns a function that creates your GraphQL context using a standard (customisable) representation, including:

- logger: a logger instance to use downstream of resolvers, usually logging some request metadata to assist correlating log entries (for example the X-Correlation-Id header value)
- requestInfo: useful request info, for example to define per-request behaviour (multi-tenant apps), pass through correlation headers to downstream services etc
- user: a user object containing claims, usually a decoded JWT payload
- anything else you wish to add to the context

### Step 1 - define your context + creation

context.ts

```ts
// define the base context type, setting the logger type
type BaseContext = GraphQLContextBase<Logger>
// define the extra stuff added to our app's context
type ExtraContext = {
  services: Services
  loaders: Loaders
}
// our app's context type, returned from the createContext function
export type GraphQLContext = BaseContext & ExtraContext

// configure the createContext function
export const createContext = createContextFactory<GraphQLContext>({
  // set the keys of the user claims (JWT payload) we want added to the request metadata passed to the requestLogger factory
  userClaimsToLog: ['oid', 'aud', 'tid', 'azp', 'iss', 'scp', 'roles'],
  // set the keys of the request info we want added to the request metadata passed to the requestLogger factory
  requestInfoToLog: ['referer', 'requestId', 'correlationId'],
  // use a winston child logger to add metadata to log output
  requestLogger: (requestMetadata) => logger.child(requestMetadata),
  // build the rest of the app context
  augmentContext: (context): ExtraContext => {
    const services = createServices(context)
    const loaders = createLoaders(services)
    return { services, loaders }
  },
})
```

### Step 2 - Map the context creation to implementation

These examples show how you might map implementation-specific context functions to your implementation-agnostic context creation function.

app.ts

```ts
// wire up the createContext function, providing `ContextInput` for apollo-server-express implementation
const server = new ApolloServer({
  ...apolloServerConfig,
  context: ({ req }) => createContext({ req, user: req.user as Claims }),
})
```

lambda.ts

```ts
// wire up the createContext function, providing `ContextInput` for apollo-server-lambda implementation
const server = new ApolloServer({
  ...apolloServerConfig,
  context: ({ event, context, express: { req } }) =>
    createContext({ req, user: req.user as Claims, event: event as LambdaEvent, context: context as LambdaContext }),
})
```

yoga.ts

```ts
// wire up the createContext function, providing `ContextInput` for graphql-yoga implementation
const graphqlServer = createServer({
  ...yogaServerConfig,
  context: ({ req }) => createContext({ req, user: req.user as Claims }),
})
```

## User

The User class adds some handy getters over the raw claims (JWT payload) to provides access to the JWT (access token) for on-behalf-of downstream authentication flows. Note this may represent a user or service principal (system) identity.

| Property | Description                                                                                  |
| -------- | -------------------------------------------------------------------------------------------- |
| claims   | The decoded JWT payload, set via the RequestInput.user field                                 |
| token    | The bearer token from the request authorization header                                       |
| email    | The user's email via coalesced claim values: email, preferred_username, unique_name, upn.    |
| name     | The user's name (via the name claim).                                                        |
| oid      | The user's unique and immutable ID, useful for contextual differentiation e.g. session keys. |
| scopes   | The user's scopes, via the scp claim split into an array of scopes.                          |
| roles    | The user's roles (via the roles claim).                                                      |

## Logging

This library exports a `logGraphQLOperation` function which will log:

- operationName: the operation name, if supplied
- query: the graphql query or mutation, or 'IntrospectionQuery'
- variables: the graphql request variables
- duration: the duration of request processing
- errors: the graphql response errors, if any

Falsy values will not be logged.

This function can be used across implementations, e.g. in an graphql-envelop plugin or ApolloServer plugin.

## Testing

The testing submodule exports utility functions for easily constructing ApolloClient instances for integration testing on NodeJS. The errorPolicy is set to 'all' so that returned errors can be checked.

- `createTestClient` accepts a url and optional accessToken.
- `createTestClientWithClientCredentials` accepts a url and client credentials config and will fetch and attach an access token to each request.

testing.ts

```ts
export const testClient = createTestClientWithClientCredentials(process.env.INTEGRATION_TEST_URL, clientCredentialsConfig)

export const unauthenticatedClient = createTestClient(process.env.INTEGRATION_TEST_URL)
```

tweets.spec.ts

```ts
describe('tweets query', () => {
  const tweetsQuery = gql`
    query Tweets($input: TweetsWhere) {
      tweets(input: $input) {
        data {
          id
          text
          createdAt
        }
        meta {
          oldestId
          newestId
          resultCount
          nextToken
          previousToken
        }
      }
    }
  `

  it('returns tweets with sensible default limit', async () => {
    const {
      data: { tweets },
      errors,
    } = await testClient.query<TweetsQuery>({
      query: tweetsQuery,
    })

    expect(errors).toBeUndefined()
    expect(tweets).toBeDefined()
    expect(tweets?.data?.length).toBe(10)
  })

  it('guards against high limit', async () => {
    const tooHighLimit = 101
    await expect(async () => {
      await testClient.query<TweetsQuery, TweetsQueryVariables>({
        query: tweetsQuery,
        variables: {
          input: {
            maxResults: tooHighLimit,
          },
        },
      })
    }).rejects.toThrowErrorMatchingInlineSnapshot(`"Response not successful: Received status code 400"`)
  })

  it('requires authorisation', async () => {
    const { data, errors } = await unauthenticatedClient.query<TweetsQuery, TweetsQueryVariables>({
      query: tweetsQuery,
    })

    expect(data.tweets).toBeNull()
    expect(errors?.length).toBe(1)
    expect(errors?.[0].message).toMatchInlineSnapshot(`"User is not authorized to access Query.tweets"`)
  })
})
```

## Utils

- `isIntrospectionQuery` returns true if the query is an introspection query, based on the operation name or query content.

## \*Express peer dependency

ApolloServer v3 standardises on the Express request representation.

GraphQL Yoga uses the NodeJS http request representation, plus adds the Express version when using an Express server.

This library therefore takes a peer dependency on Express as the standard (common) request representation.

The ApolloServer [v4 roadmap](https://github.com/apollographql/apollo-server/blob/main/ROADMAP.md#replace-9-core-maintained-bindings-with-a-stable-http-abstraction) will standardise on the NodeJS http request representation.

This library will swap to the NodeJS http representation in a future version.
