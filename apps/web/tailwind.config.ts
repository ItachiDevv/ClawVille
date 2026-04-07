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
        // Ocean theme palette
        claw: {
          primary: '#1B4D89',
          accent: '#00E5FF',
          gold: '#FFD700',
          'gold-light': '#FFF4B0',
          'gold-dark': '#D4A900',
          green: '#00E676',
          'green-dark': '#00C853',
          blue: '#42A5F5',
          red: '#FF5252',
          panel: '#E8F1F5',
          'panel-border': '#2E6EB5',
          bg: '#0A1628',
          'bg-dark': '#060D17',
          star: '#FFD700',
          coral: '#FF6B35',
        },
        // Keep neopets aliases for backwards compatibility with existing classes
        neopets: {
          yellow: '#FFD700',
          'yellow-light': '#FFF4B0',
          'yellow-dark': '#D4A900',
          green: '#00E676',
          'green-dark': '#00C853',
          blue: '#42A5F5',
          red: '#FF5252',
          panel: '#E8F1F5',
          'panel-border': '#2E6EB5',
          bg: '#0A1628',
          'bg-dark': '#060D17',
          star: '#FFD700',
        },
        'claw-accent': '#00E5FF',
      },
      fontFamily: {
        clawville: ['var(--font-clawville)', 'Comic Sans MS', 'cursive'],
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
