import { defineConfig } from 'vite';

// `base: './'` keeps the build portable so it works on GitHub Pages
// under any repository name.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
} as any);
