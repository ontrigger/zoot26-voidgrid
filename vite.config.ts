import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The page and its sources live in site/; scripts/build.py writes the map data to site/data/, which the dev server serves
// as it is. `vite build` writes the page alone to dist/ (scripts/publish.py adds the data next to it).
export default defineConfig({
  // absolute with an upper-case drive letter, as Vite resolves it elsewhere: a cwd of f:\ rather than F:\ breaks
  // the build (the page's inline <style> isn't found)
  root: fileURLToPath(new URL('./site', import.meta.url)).replace(/^[a-z]:/, d => d.toUpperCase()),
  base: './',
  publicDir: false,
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 }, // three is ~600 kB
  server: { watch: { ignored: ['**/data/**'] } },
});
