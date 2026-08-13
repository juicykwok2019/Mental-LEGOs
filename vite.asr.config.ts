import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    sourcemap: false,
    lib: {
      entry: 'src/asr/worker.ts',
      formats: ['es'],
      fileName: () => 'asr-worker.mjs',
    },
    rollupOptions: {
      external: ['sherpa-onnx-node'],
    },
  },
});
