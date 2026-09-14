import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.LOD_WEB_PORT ?? 5173),
    strictPort: true,
    // The analytics engine is a local native process. Proxying keeps CORS unnecessary and
    // allows the backend to remain bound only to 127.0.0.1.
    proxy: {
      '/api': { target: process.env.LOD_API_URL ?? 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
});
