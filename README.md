# GraphQL Core

A set of core GraphQL utilities that MakerX uses to build GraphQL APIs.

These utilities avoid dependencies on any particular GraphQL server or logging implementation, providing a standard set of behaviours to use across varying implementations.

Note: See explanation on \*Express peer dependency below.

## Context

`createContextFactory` returns a function that creates your GraphQL context using a standard (extensible) representation, including:

- `logger`: a logger instance to use downstream of resolvers, built by your `requestLogger` factory, which receives both the resolved request metadata and the resolved `user` so you can enrich log output with user-derived fields (see [Request logger](#request-logger))
- `requestInfo`: useful request info — `source` (`http` or `subscription`), `protocol` (`http`/`https`/`ws`/`wss`), `host`, `baseUrl`, `url`, correlation/client headers, etc. Use it for per-request behaviour (multi-tenant apps), passing correlation headers downstream, etc. See [Request info](#request-info)
- `user`: an object representing the user or system identity (see [User](#user); defaults to a `User` built from JWT claims when `createUser` is omitted)
- anything else you wish to add to the context via `augmentContext`

### Step 1 - Define your context + creation

context.ts

```ts
// define the extra stuff added to our app's context
type ExtraContext = {
  services: Services
  loaders: Loaders
}

// configure the createContext function
// TUser is inferred from `createUser`, TAugment is inferred from `augmentContext`'s return type
export const createContext = createContextFactory({
  // keys of the user claims (JWT payload) to include in the request metadata passed to the requestLogger factory
  claimsToLog: ['oid', 'aud', 'tid', 'azp', 'iss', 'scp', 'roles'],
  // keys of the request info to include in the request metadata passed to the requestLogger factory
  requestInfoToLog: ['origin', 'requestId', 'correlationId'],
  // build the per-request logger; receives the request metadata and the resolved user
  // e.g. enrich log output with user-derived fields like multi-tenant `instance`
  requestLogger: (requestMetadata, user) => logger.child({ ...requestMetadata, instance: user?.instance }),
  // resolve the user for each request — optional; omit to use the default User-from-JWT behaviour
  // (required when you supply a narrower TUser generic)
  createUser: async ({ claims }) => new AppUser(claims),
  // build the rest of the app context — annotate the return type to lock in inference
  augmentContext: (context): ExtraContext => {
    const services = createServices(context)
    const loaders = createLoaders(services)
    return { services, loaders }
  },
})

// derive the full context type from the factory's return type
export type GraphQLContext = Awaited<ReturnType<typeof createContext>>
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

## Request info

`context.requestInfo` is built for every request — both HTTP and websocket subscription connects — so downstream code can distinguish sources, rebuild URLs, pass through correlation headers, etc.

| Field           | Description                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requestId`     | `x-request-id` header if present, otherwise a freshly generated UUID.                                                                                                          |
| `source`        | `'http'` for regular requests, `'subscription'` for websocket connects.                                                                                                        |
| `protocol`      | `'http'` / `'https'` for HTTP, `'ws'` / `'wss'` for subscriptions (resolved via `x-forwarded-proto` or TLS socket encryption).                                                 |
| `host`          | Hostname only (no port). Prefers `x-forwarded-host`, falls back to the `Host` header, then `req.hostname` (Express only).                                                      |
| `port`          | Port parsed from `x-forwarded-host` / `Host` header when present; `undefined` otherwise.                                                                                       |
| `baseUrl`       | Fully-qualified origin (`scheme://host[:port]`) with default ports stripped. For subscriptions the scheme is normalised to `http(s)` so the value composes with relative URLs. |
| `url`           | `req.originalUrl` for HTTP, `req.url` for subscription connects.                                                                                                               |
| `origin`        | `Origin` header.                                                                                                                                                               |
| `referer`       | `Referer` header.                                                                                                                                                              |
| `correlationId` | `x-correlation-id` header.                                                                                                                                                     |
| `arrLogId`      | `x-arr-log-id` header (Azure Front Door / ARR).                                                                                                                                |
| `clientIp`      | First value from `x-forwarded-for`, falling back to `socket.remoteAddress`.                                                                                                    |
| `userAgent`     | `User-Agent` header.                                                                                                                                                           |

You can add more via `augmentRequestInfo(input)`. Lambda deployments also get `functionName` and `awsRequestId` when a `LambdaContext` is supplied.

Helpers are exported for custom wiring: `buildBaseRequestInfo(req)` (Express), `buildConnectRequestInfo(req)` (websocket `IncomingMessage`), and `requestBaseUrl` / `connectRequestBaseUrl`.

## Request logger

The `requestLogger` config accepts either a pre-built `Logger` or a factory `(requestMetadata, user) => Logger`.

The factory form runs per request and receives:

- `requestMetadata` — an object containing `request` (the subset of `requestInfo` selected by `requestInfoToLog`) and `user` (the subset of claims selected by `claimsToLog`)
- `user` — the resolved `user` value returned by `createUser` (typed as your `TUser`)

This lets you enrich log output with fields derived from the resolved user, for example a multi-tenant instance id or an internal user id from your database, that aren't present on the raw JWT claims:

```ts
requestLogger: (requestMetadata, user) =>
  logger.child({
    ...requestMetadata,
    instance: user?.instance,
    userId: user?.id,
  }),
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

## Shield (authorization)

The `shield` module provides typed helpers around [graphql-shield](https://the-guild.dev/graphql/shield) for defining authorization middleware against your generated `Resolvers` type.

`graphql-shield` is an optional peer dependency — install it only if you use this module:

```sh
npm i graphql-shield
```

### createShieldSchema

Builds a shield middleware with a schema typed against your resolver map, so field-level rule wiring is checked by the TypeScript compiler.

```ts
import { Resolvers } from '../generated/types'
import { or } from 'graphql-shield'
import { applyMiddleware } from 'graphql-middleware'
import { createShieldSchema, hasRoleRule, unauthorisedError } from '@makerx/graphql-core'

const isCoordinator = hasRoleRule('coordinator')
const isSystemAdmin = hasRoleRule('system-admin')
const isAuthorisedUser = or(isCoordinator, isSystemAdmin)

const shieldSchema = createShieldSchema<Resolvers>(
  {
    Query: {
      '*': isAuthorisedUser,
      user: isCoordinator,
    },
    Mutation: {
      '*': isCoordinator,
      createUser: isSystemAdmin,
    },
  },
  { fallbackRule: isAuthorisedUser, fallbackError: unauthorisedError() },
)

const schema = applyMiddleware(makeExecutableSchema({ ... }), shieldSchema)
```

The `'*'` key at each object level is a fallback rule applied to any field at that level without an explicit rule.

The wrapper defaults `allowExternalErrors: true`; the full shield options object (second argument) is forwarded to `shield(...)` and can override it.

#### v3 breaking change: no default fallback rule

Prior to v3 this wrapper defaulted `fallbackRule` to `allow` — fields not covered by the schema were open by default. v3 removes that default and the wrapper no longer makes that choice for you. Without an explicit `fallbackRule`, graphql-shield's own default (`allow`) still applies, so behaviour is unchanged when no options are passed, but if you want a deny-by-default posture you should now pass an explicit `fallbackRule` (commonly your auth-check rule) along with a `fallbackError`.

The second argument also changed from a bare `ShieldRule` to the full shield options object:

```ts
// v2
createShieldSchema<Resolvers>(schema, isAuthorisedUser)

// v3
createShieldSchema<Resolvers>(schema, { fallbackRule: isAuthorisedUser, fallbackError: unauthorisedError() })
```

### Role and scope rules

Convenience builders that read `ctx.user.roles` / `ctx.user.scopes`. All use graphql-shield's `'contextual'` cache so the result is reused across fields within a request.

| Helper                                   | Description                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `hasRoleRule(role, ruleName?)`           | Passes when `user.roles` includes `role`.                                     |
| `hasAnyRoleRule(...roles)`               | Passes when `user.roles` includes at least one of `roles`.                    |
| `hasAnyRoleRuleWithName(name, ...roles)` | Same, with an explicit rule name / cache key for large or dynamic role lists. |
| `hasScopeRule(scope)`                    | Passes when `user.scopes` includes `scope`.                                   |
| `hasAnyScopeRule(...scopes)`             | Passes when `user.scopes` includes at least one of `scopes`.                  |

### createRule

Strongly typed wrapper around graphql-shield's `rule(...)`. Mirrors the underlying call signature — `createRule(name?, options?)(fn)` — but types `parent`, `args` and `ctx` on `fn` to your generics instead of `any`.

```ts
const isOwner = createRule<GraphQLContext, { ownerId: string }>()((parent, _, ctx) => parent.ownerId === ctx.user?.id)

const isAdmin = createRule<GraphQLContext>('isAdmin', { cache: 'contextual' })((_, __, ctx) => ctx.user?.roles.includes('admin') === true)
```

Generics are `<TContext, TParent = unknown, TArgs = unknown>`. The `name` and `options` arguments are forwarded verbatim to graphql-shield's `rule`.

### combineRuleWithAll

Composes a rule with every rule in an existing shield schema via a combinator (`and` | `or` | `chain` | `race`). Useful for post-hoc gating — e.g. bolting a "not blocked" check onto an existing schema without touching each field:

```ts
import { chain } from 'graphql-shield'

const gated = combineRuleWithAll(shieldSchema, accountNotBlocked, chain)
```

### Authorization errors

The `unauthorised` module provides shared helpers for producing forbidden errors used by the shield wrapper and by resolvers.

| Helper                                     | Description                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `unauthorisedError(message?)`              | Builds a `GraphQLError` with Apollo's `FORBIDDEN` extension code and HTTP 403 status.                   |
| `throwUnauthorised(message?)`              | Throws `unauthorisedError`; return type is `never` so TypeScript narrows control flow past the call.    |
| `permissionInvariant(condition, message?)` | Assertion helper: throws `unauthorisedError` when `condition` is false, otherwise narrows it to `true`. |

```ts
permissionInvariant(ctx.user?.id === record.ownerId, 'Only the owner can edit this record')
// past this line, TypeScript knows the condition held
```

## Logging

### logGraphQLOperation

Logs a GraphQL operation in a consistent format with the option of including any additional data. Top level and result level log data with null or undefined values will be omitted for berevity.

Refer to the `GraphQLLogOperationInfo` type for the definition of input.

This function can be used across implementations, e.g. in a [GraphQL Envelop plugin](https://www.envelop.dev/docs/plugins) or [ApolloServer plugin](https://github.com/MakerXStudio/graphql-apollo-server/blob/main/src/plugins/graphql-operation-logging-plugin.ts).

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
   type ExtraContext = { services: Services; dataSource: DataSource; dataLoaders: DataLoaders }

   // the `context` arg is typed `GraphQLContext<Logger, RequestInfo, AppUser | undefined>` here —
   // TUser flows through from `createUser`, so just annotate the return type and let inference do the rest
   const augmentContext = (context: GraphQLContext<Logger, RequestInfo, AppUser | undefined>): ExtraContext => {
     const services = createServices(context)
     const dataLoaders = createDataLoaders()
     return { services, dataSource, dataLoaders }
   }

   // create a context using request based input — TUser / TAugment inferred from the config
   const createContext = createContextFactory({
     claimsToLog,
     requestInfoToLog,
     requestLogger: (requestMetadata, user) => logger.child({ ...requestMetadata, instance: user?.instance }),
     createUser: ({ claims, req }) => findUpdateOrCreateUser(claims, req.headers.authorization?.substring(7)),
     augmentContext,
   })

   // create a context using graphql-ws Server#context callback input
   const createSubscriptionContext = createSubscriptionContextFactory({
     claimsToLog,
     requestInfoToLog,
     requestLogger: (requestMetadata, user) => logger.child({ ...requestMetadata, instance: user?.instance }),
     createUser: ({ claims, connectionParams }) => findUpdateOrCreateUser(claims, extractTokenFromConnectionParams(connectionParams)),
     augmentContext,
   })

   // share one context type between query and subscription paths
   export type GraphQLContext = Awaited<ReturnType<typeof createContext>>
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

## Utils

- `isIntrospectionQuery`: indicates whether the query is an introspection query, based on the operation name or query content.

## \*Express peer dependency

ApolloServer v3 standardises on the Express request representation.

GraphQL Yoga uses the NodeJS http request representation, plus adds the Express version when using an Express server.

This library therefore takes a peer dependency on Express as the standard (common) request representation.

The ApolloServer [v4 roadmap](https://github.com/apollographql/apollo-server/blob/main/ROADMAP.md#replace-9-core-maintained-bindings-with-a-stable-http-abstraction) will standardise on the NodeJS http request representation.

This library may swap to the NodeJS http representation in a future version.
