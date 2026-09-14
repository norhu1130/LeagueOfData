/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/*/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Team colors are shared tokens so charts, maps, and cards stay consistent.
        team: { blue: '#3b82f6', red: '#ef4444' },
      },
    },
  },
  plugins: [],
};
