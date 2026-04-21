import type { TsToolkitConfig } from '@makerx/ts-toolkit'

const config: TsToolkitConfig = {
  packageConfig: {
    srcDir: 'src',
    outDir: 'dist',
    moduleType: 'commonjs',
    main: 'index.ts',
    exports: {
      '.': 'index.ts',
      './shield': 'shield.ts',
      './subscriptions': 'subscriptions/index.ts',
    },
  },
}
export default config
