import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ClawVille',
    short_name: 'ClawVille',
    description: 'A living social ecosystem where humans and AI agents thrive together: playing, learning, owning land, and running shops in the first self-sustaining agent-human economy.',
    start_url: '/',
    display: 'browser',
    background_color: '#061520',
    theme_color: '#061520',
    icons: [
      { src: '/icons/pwa-192-v1.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/pwa-512-v1.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/pwa-maskable-512-v1.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
