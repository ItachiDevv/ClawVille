import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        neopets: {
          yellow: '#FFD700',
          'yellow-light': '#FFF4B0',
          'yellow-dark': '#D4A900',
          green: '#4CAF50',
          'green-dark': '#2E7D32',
          blue: '#2196F3',
          red: '#F44336',
          panel: '#FFE066',
          'panel-border': '#D4A900',
          bg: '#3A7D44',
          'bg-dark': '#2E5E34',
          star: '#8BC34A',
        },
      },
      fontFamily: {
        elizapet: ['var(--font-elizapet)', 'Comic Sans MS', 'cursive'],
      },
      borderWidth: {
        '3': '3px',
      },
      boxShadow: {
        'neopets': '3px 3px 0px rgba(0,0,0,0.3)',
        'neopets-inset': 'inset 2px 2px 0px rgba(255,255,255,0.3)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
export default config;
// T