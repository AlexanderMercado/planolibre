import { defineConfig } from 'vite';

// Compila la línea de comandos y el servidor MCP (Node) en bin/planolibre.mjs.
// Las dependencias quedan fuera del archivo y se cargan desde node_modules.
export default defineConfig({
  build: {
    ssr: 'src/cli/main.ts',
    outDir: 'bin',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'planolibre.mjs', chunkFileNames: 'partes/[name]-[hash].mjs', banner: '#!/usr/bin/env node' } },
  },
});
