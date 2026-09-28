import { defineConfig } from 'vite';

// Relative asset paths, so the build works from any subpath (GitHub Pages serves it under /<repo>/).
export default defineConfig({
  base: './',
});
