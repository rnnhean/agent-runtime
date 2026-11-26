import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/health': 'http://127.0.0.1:8790', '/api': 'http://127.0.0.1:8790', '/metrics': 'http://127.0.0.1:8790' } },
});
