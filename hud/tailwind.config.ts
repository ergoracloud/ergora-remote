import type { Config } from 'tailwindcss';

// Mirrors Ergora's brand tokens (see src/app/globals.css in ergora-app):
//   --ergora-green: #1a5c3e
//   amber accent:   #f59e0b
// HUD palette stays slate-glass; tinting comes from these two accents.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ergora: {
          green: '#1a5c3e',
          'green-soft': '#2c8f63',
          amber: '#f59e0b',
          'amber-soft': '#fbbf24',
        },
      },
      backdropBlur: {
        hud: '24px',
      },
      boxShadow: {
        hud: '0 12px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255,255,255,0.06) inset',
      },
      animation: {
        'hud-in': 'hud-in 160ms ease-out',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
      },
      keyframes: {
        'hud-in': {
          '0%':   { opacity: '0', transform: 'translateY(-4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%':      { opacity: '0.85', transform: 'scale(1.06)' },
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;
