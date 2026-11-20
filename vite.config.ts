import { defineConfig } from 'vite';

// base './' permite servir la carpeta dist desde cualquier ruta (o GitHub Pages).
export default defineConfig({
  base: './',
  server: { port: 5199, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  optimizeDeps: { exclude: ['@mlightcad/libredwg-web'] },
});
