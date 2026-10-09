import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
export default defineConfig({
  plugins: [wasm()],
  build: { target: 'esnext' },
  optimizeDeps: {
    exclude: ['@reactor-team/js-sdk'],
    include: ['react', 'react-dom/client', 'react/jsx-runtime', '@reactor-team/js-sdk > awaitqueue'],
  },
});
