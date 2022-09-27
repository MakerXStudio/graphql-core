# GraphQL Core

A set of core GraphQL utilities that MakerX uses to build GraphQL APIs.

## Context

`createContextFactory` returns a function that creates your GraphQL context using a standard (customisable) representation, including:

- logger: a logger instance that will log useful request metadata to assist correlating log entries
- requestInfo: useful request info, for example to define per-request behaviour (multi-tenant apps) or
- user: a user object containing claims, usually a decoded JWT payload
- anything else you wish to add to the context

### Step 1 - define your context + creation

context.ts

```ts
// define the base context type, setting the logger type
export type BaseContext = GraphQLContextBase<typeof logger>
// define the augmented context type, returned from the createContext function
export type GraphQLContext = BaseContext & {
  services: Services
}

// create the createContext function using app config
export const createContext = createContextFactory<BaseContext>({
  userClaimsToLog: config.get<string[]>('logging.userClaimsToLog'),
  requestInfoToLog: config.get<string[]>('logging.requestInfoToLog'),
  requestLogger: (requestMetadata) => logger.child(requestMetadata),
  augmentContext: (context) => {
    const services = createServices(context)
    return { services }
  },
})
```

### Step 2 - provide ApolloServer context function

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

## User

## Logging

## Testing

## Utils
