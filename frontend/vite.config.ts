import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/suggest': { target: 'http://localhost:3001', changeOrigin: true },
      '/search':  { target: 'http://localhost:3001', changeOrigin: true },
      '/trending':{ target: 'http://localhost:3001', changeOrigin: true },
      '/cache':   { target: 'http://localhost:3001', changeOrigin: true },
      '/metrics': { target: 'http://localhost:3001', changeOrigin: true },
      '/health':  { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    host: '0.0.0.0',
  },
});
