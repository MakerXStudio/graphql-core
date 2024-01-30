import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import type { RollupOptions } from 'rollup'
import pkg from './package.json' with { type: 'json' }

const config: RollupOptions = {
  input: 'src/index.ts',
  output: [
    {
      dir: 'dist',
      format: 'cjs',
      entryFileNames: '[name].cjs',
      preserveModules: true,
    },
    {
      dir: 'dist',
      format: 'es',
      entryFileNames: '[name].mjs',
      preserveModules: true,
    },
  ],
  treeshake: {
    moduleSideEffects: false,
    propertyReadSideEffects: false,
  },
  external: ['graphql-ws/lib/use/ws', ...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})],
  plugins: [
    typescript({
      tsconfig: 'tsconfig.build.json',
    }),
    nodeResolve(),
  ],
}

export default config
