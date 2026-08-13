import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    sourcemap: false,
    lib: {
      entry: 'src/agent/worker.ts',
      formats: ['es'],
      fileName: () => 'worker.mjs',
    },
  },
});
