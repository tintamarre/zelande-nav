import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // Chemins relatifs : l'app fonctionne dans un sous-dossier (GitHub Pages) comme dans Capacitor
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { chunkSizeWarningLimit: 1500 },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'fonts/**/*.pbf', 'fonts/OFL.txt'],
      manifest: {
        name: 'Zélande Nav',
        short_name: 'Zélande Nav',
        description: 'Carte de navigation hors-ligne de la Zélande pour voiliers (Rijkswaterstaat IENC)',
        lang: 'fr',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0b3d5c',
        theme_color: '#0b3d5c',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // Coquille de l'app + polices en précache ; la carte (.pmtiles) est gérée à part (chart.ts)
        globPatterns: ['**/*.{js,css,html,svg,png,pbf,txt}'],
        globIgnores: ['tiles/**'],
        maximumFileSizeToCacheInBytes: 3_000_000,
        navigateFallbackDenylist: [/\/tiles\//], // l'app peut être servie dans un sous-dossier
      },
    }),
  ],
});
