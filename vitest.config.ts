import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@lol/data-model': r('./packages/data-model/src/index.ts'),
      '@lol/catalog': r('./packages/catalog/src/index.ts'),
      '@lol/ast': r('./packages/ast/src/index.ts'),
      '@lol/dsl': r('./packages/dsl/src/index.ts'),
      '@lol/validate': r('./packages/validate/src/index.ts'),
      '@lol/map-editor': r('./packages/map-editor/src/index.ts'),
      '@lol/charts': r('./packages/charts/src/index.ts'),
      '@lol/analysis-client': r('./packages/analysis-client/src/index.ts'),
      '@lol/visual-builder': r('./packages/visual-builder/src/index.ts'),
    },
  },
});
