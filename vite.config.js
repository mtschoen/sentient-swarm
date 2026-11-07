import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.PAGES_BASE || '/',
  build: {
    // Shaders stay separate files (fetched by loadShader) instead of small ones becoming data URLs.
    assetsInlineLimit: (filePath) => (filePath.endsWith('.wgsl') ? false : undefined),
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
