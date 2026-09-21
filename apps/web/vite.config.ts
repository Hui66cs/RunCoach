import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_WEB_PORT ?? 5173),
    proxy: {
      '/api': process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3100',
    },
  },
});
