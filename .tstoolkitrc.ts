import type { TsToolkitConfig } from "@makerx/ts-toolkit";

const config: TsToolkitConfig = {
  packageConfig: {
    srcDir: 'src',
    outDir: 'dist',
    moduleType: 'module',
    main: 'index.ts',
    exports: {
      '.': 'index.ts',
      './testing': 'testing.ts',
      './subscriptions': 'subscriptions/index.ts'
    }
  }
}
export default config
