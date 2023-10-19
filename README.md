# GraphQL Core

A set of core GraphQL utilities that MakerX uses to build GraphQL APIs.

These utilities avoid dependencies on any particular GraphQL server or logging implementation, providing a standard set of behaviours to use across varying implementations.

Note: See explanation on \*Express peer dependency below.

## Context

`createContextFactory` returns a function that creates your GraphQL context using a standard (extensible) representation, including:

- `logger`: a logger instance to use downstream of resolvers, usually logging some request metadata to assist correlating log entries (for example the X-Correlation-Id header value)
- `requestInfo`: useful request info, for example to define per-request behaviour (multi-tenant apps), pass through correlation headers to downstream services etc
- `user`: an object representing the user or system identity (see definition below, defaults to creating a `User` based on JWT claims)
- anything else you wish to add to the context

### Step 1 - Define your context + creation

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
  claimsToLog: ['oid', 'aud', 'tid', 'azp', 'iss', 'scp', 'roles'],
  // set the keys of the request info we want added to the request metadata passed to the requestLogger factory
  requestInfoToLog: ['origin', 'requestId', 'correlationId'],
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

These examples show how you might map implementation-specific context functions to your implementation-agnostic context creation function (from step 1).
Note: examples assume that a JWT auth middleware has set `req.user` to the decoded token payload (claims). This is optional.

app.ts

```ts
// wire up the createContext function, providing `ContextInput` for apollo-server-express implementation)
const server = new ApolloServer({
  ...apolloServerConfig,
  context: ({ req }) => createContext({ req, claims: req.user }),
})
```

lambda.ts

```ts
// wire up the createContext function, providing `ContextInput` for apollo-server-lambda implementation
const server = new ApolloServer({
  ...apolloServerConfig,
  context: ({ event, context, express: { req } }) =>
    createContext({ req, claims: req.user, event: event as LambdaEvent, context: context as LambdaContext }),
})
```

yoga.ts

```ts
// wire up the createContext function, providing `ContextInput` for graphql-yoga implementation
const graphqlServer = createServer({
  ...yogaServerConfig,
  context: ({ req }) => createContext({ req, claims: req.user }),
})
```

## User

By default, if `claims` (decoded token `JwtPayload`) are available, the `GraphQLContext.user` property will be set by constructing a `User` instance.

The User class adds some handy getters over raw claims (decodedJWT payload) and provides access to the JWT (access token) for on-behalf-of downstream authentication flows. Note this may represent a user or service principal (system) identity.

| Property | Description                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| claims   | The decoded JWT payload, set via the RequestInput.user field.                                                       |
| token    | The bearer token from the request authorization header.                                                             |
| email    | The user's email via coalesced claim values: email, emails, preferred_username, unique_name, upn.                   |
| name     | The user's name (via the name or given_name and family_name claims).                                                |
| id       | The user's unique and immutable ID, useful for contextual differentiation e.g. session keys (the oid or sub claim). |
| scopes   | The user's scopes, via the scp claim split into an array of scopes.                                                 |
| roles    | The user's roles (via the roles claim).                                                                             |

### Custom user

If you wish to customise your `GraphQLContext.user` object, provide a `createUser` function to override the default `User` creation.

```ts
const createUser: CreateUser = async ({ claims }) => {
  const roles = await loadRoles(claims.email)
  return { name: claims.name, email: claims.email, roles }
}

const graphqlServer = createServer({
  ...config,
  context: ({ req }) => createContext({ req, claims: req.user, createUser }),
})
```

## Logging

### logGraphQLOperation

The `logGraphQLOperation` function will log:

- `operationName`: the operation name, if supplied
- `query`: the formatted graphql query or mutation, or 'IntrospectionQuery'
- `variables`: the graphql request variables
- `duration`: the duration of request processing
- `errors`: the graphql response errors, if any

Notes:

- null or undefined values will be omitted
- introspection queries will not be logged outside of production

This function can be used across implementations, e.g. in a [GraphQL Envelop plugin](https://www.envelop.dev/docs/plugins) or [ApolloServer plugin](https://www.apollographql.com/docs/apollo-server/integrations/plugins/).

## GraphQL subscriptions

This library includes a `subscriptions` module to provide simple setup using the [GraphQL WS](https://the-guild.dev/graphql/ws) package.

1. Install subscriptions dependencies (optional peer dependencies of this package):
   ```
   npm i graphql-ws ws
   ```
1. Subscription context setup:

   `createSubscriptionContextFactory` returns a function that creates an equivalent GraphQL context using input supplied to the [graphql-ws Server context callback](https://the-guild.dev/graphql/ws/docs/interfaces/server.ServerOptions#onconnect).

   Example showing both normal context + subscription context creation:

   ```ts
   const augmentContext = (context: GraphQLContext) => {
     const services = createServices(context)
     const dataLoaders = createDataLoaders()
     return { services, dataSource, dataLoaders }
   }

   // create a context using request based input
   const createContext = createContextFactory<GraphQLContext>({
     claimsToLog,
     requestInfoToLog,
     requestLogger: (requestMetadata) => logger.child(requestMetadata),
     createUser: ({ claims, req }) => findUpdateOrCreateUser(claims, req.headers.authorization?.substring(7)),
     augmentContext,
   })

   // create a context using graphql-ws Server#context callback input
   const createSubscriptionContext = createSubscriptionContextFactory<GraphQLContext>({
     claimsToLog
     requestInfoToLog,
     requestLogger: (requestMetadata) => logger.child(requestMetadata),
     createUser: ({ claims, connectionParams }) => findUpdateOrCreateUser(claims, extractTokenFromConnectionParams(connectionParams)),
     augmentContext,
   })
   ```

1. Create a subscriptions server, using the ws-server cleanup function in your server lifecycle.

   The `useSubscriptionsServer` function sets up:

   - Auth token validation as part of establishing (or rejecting) the connection (behaviour defined by `verifyToken` and `requireAuth` args)
   - GraphQL context creation
   - Logging from the server `onConnect`, `onDisconnect`, `onOperation`, `onNext` and `onError` callbacks

   Example for Apollo Server (`wsServerCleanup` called in the `drainServer` plugin callback):

   ```ts
    export const startApolloServer = async (app: Express, httpServer: http.Server) => {
      logger.info('Building schema')
      const schema = createSchema()

      logger.info('Initialising subscriptions websocket server')
      const wsServerCleanup = useSubscriptionsServer({
        schema,
        httpServer,
        logger,
        createSubscriptionContext,
        jwtClaimsToLog: config.get('logging.userClaimsToLog'),
        requireAuth: true,
        verifyToken: (host, token) => verifyForHost(host, token, config.get('auth.bearer')),
      })

      logger.info('Starting apollo server')
      const server = new ApolloServer<GraphQLContext>({
        schema,
        plugins: plugins(httpServer, wsServerCleanup),
        introspection: true,
        csrfPrevention: true,
      })
      await server.start()

   ```

1. For authorisation, clients can include a connection parameter named `authorization` or `Authorization` using the HTTP header format `Bearer <token>`. Note: [Apollo Sandbox](https://studio.apollographql.com/sandbox/explorer) will include an `Authorization` connection parameter when you specify an HTTP `Authorization` header via the UI.

## Testing

The testing submodule exports utility functions for easily constructing ApolloClient instances for integration testing on NodeJS. The `errorPolicy` is set to `all` so that returned errors can be checked.

### Setup

If you use this module, you need to install `@apollo/client`:

```
npm install --save-dev @apollo/client
```

### Usage

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
          text
          createdAt
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

- `isIntrospectionQuery`: indicates whether the query is an introspection query, based on the operation name or query content.

## \*Express peer dependency

ApolloServer v3 standardises on the Express request representation.

GraphQL Yoga uses the NodeJS http request representation, plus adds the Express version when using an Express server.

This library therefore takes a peer dependency on Express as the standard (common) request representation.

The ApolloServer [v4 roadmap](https://github.com/apollographql/apollo-server/blob/main/ROADMAP.md#replace-9-core-maintained-bindings-with-a-stable-http-abstraction) will standardise on the NodeJS http request representation.

This library may swap to the NodeJS http representation in a future version.
