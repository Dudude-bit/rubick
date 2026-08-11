/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Role tokens (one flat canvas)
        canvas: 'hsl(var(--canvas))',
        // Overlays only — see --raise in index.css.
        raise: 'hsl(var(--raise))',
        hair: 'hsl(var(--hair))',
        hover: 'hsl(var(--hover))',
        sel: 'hsl(var(--sel))',
        fg: {
          DEFAULT: 'hsl(var(--fg))',
          mid: 'hsl(var(--fg-mid))',
          mut: 'hsl(var(--fg-mut))',
          fnt: 'hsl(var(--fg-fnt))',
        },
        // `<alpha-value>` is required for opacity modifiers such as
        // `bg-ok/[0.16]` to work against a CSS-variable colour. Without
        // it Tailwind emits the colour and silently drops the alpha.
        ok: 'hsl(var(--ok) / <alpha-value>)',
        warn: 'hsl(var(--warn) / <alpha-value>)',
        err: 'hsl(var(--err) / <alpha-value>)',
        info: 'hsl(var(--info) / <alpha-value>)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'pulse-subtle': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        // A ring rather than a blink: the dot marks a session that is still
        // attached, and something that flashes on and off in a tab strip
        // reads as an error asking to be dismissed.
        'tab-live': {
          '0%': { boxShadow: '0 0 0 0 hsl(var(--ok) / 0.6)' },
          '70%': { boxShadow: '0 0 0 4px hsl(var(--ok) / 0)' },
          '100%': { boxShadow: '0 0 0 0 hsl(var(--ok) / 0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'pulse-subtle': 'pulse-subtle 2s ease-in-out infinite',
        'fade-in': 'fade-in var(--animation-normal) ease-out',
        'slide-in': 'slide-in var(--animation-normal) ease-out',
        'scale-in': 'scale-in var(--animation-normal) ease-out',
        'fade-in-fast': 'fade-in var(--animation-fast) ease-out',
        'fade-in-slow': 'fade-in var(--animation-slow) ease-out',
        'tab-live': 'tab-live 2.4s ease-out infinite',
      },
      fontFamily: {
        // "Variable" suffix matches the family name @fontsource-variable
        // registers; the static names are kept as a fallback so a partial
        // install still renders in the intended face.
        sans: ['Inter Variable', 'Inter', 'system-ui', 'sans-serif'],
        mono: [
          'JetBrains Mono Variable',
          'JetBrains Mono',
          'Consolas',
          'monospace',
        ],
      },
      boxShadow: {
        pop: 'var(--pop-shadow)',
      },
      transitionDuration: {
        'ds-fast': 'var(--animation-fast)',
        'ds-normal': 'var(--animation-normal)',
        'ds-slow': 'var(--animation-slow)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
