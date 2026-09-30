import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: {
      deps: {
        // Vite resolves `graphql` to its ESM build, but Node loads its CJS build for an externalised graphql-ws.
        // Inlining graphql-ws makes both use the same graphql instance, so schemas built in tests pass its realm check.
        inline: ['graphql-ws'],
      },
    },
  },
})
