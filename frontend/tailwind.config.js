/** @type {import('tailwindcss').Config} */

// Ramps are CSS variables (space-separated RGB triplets, see src/index.css) so
// the whole UI re-themes under `.dark` without touching any component class.
const ramp = (name) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((n) => [n, `rgb(var(--${name}-${n}) / <alpha-value>)`]),
  );

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Konekto brand blue ramp. The key keeps its old name ("celeste") so the
        // ~80 existing utility classes pick up the new brand without a rename.
        celeste: ramp('c'),
        // Tailwind's slate scale, re-pointed at variables so it flips in dark mode.
        slate: ramp('s'),
        surface: 'rgb(var(--surface) / <alpha-value>)',
        // Fixed brand colors, sampled from the Konekto logo (not theme-dependent).
        brand: {
          navy: '#142B54',
          cyan: '#09B8CD',
          blue: '#0580A1',
          green: '#11B787',
          ink: '#0C1B38',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
