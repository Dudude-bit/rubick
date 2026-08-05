/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Role tokens (one flat canvas)
        canvas: 'hsl(var(--canvas))',
        hair: 'hsl(var(--hair) / 0.07)',
        hover: 'hsl(var(--hover) / 0.04)',
        sel: 'hsl(var(--sel) / 0.09)',
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
        // Kubernetes resource status colors (design system)
        success: {
          DEFAULT: 'hsl(var(--status-running))',
          foreground: 'hsl(0 0% 100%)',
        },
        warning: {
          DEFAULT: 'hsl(var(--status-warning))',
          foreground: 'hsl(0 0% 0%)',
        },
        error: {
          DEFAULT: 'hsl(var(--status-error))',
          foreground: 'hsl(0 0% 100%)',
        },
        pending: {
          DEFAULT: 'hsl(var(--status-pending))',
          foreground: 'hsl(0 0% 100%)',
        },
        // Status semantic colors
        status: {
          running: 'hsl(var(--status-running))',
          ready: 'hsl(var(--status-ready))',
          available: 'hsl(var(--status-available))',
          active: 'hsl(var(--status-active))',
          succeeded: 'hsl(var(--status-succeeded))',
          pending: 'hsl(var(--status-pending))',
          waiting: 'hsl(var(--status-waiting))',
          progressing: 'hsl(var(--status-progressing))',
          warning: 'hsl(var(--status-warning))',
          degraded: 'hsl(var(--status-degraded))',
          error: 'hsl(var(--status-error))',
          failed: 'hsl(var(--status-failed))',
          terminated: 'hsl(var(--status-terminated))',
          completed: 'hsl(var(--status-completed))',
          unknown: 'hsl(var(--status-unknown))',
        },
        // Resource type colors
        resource: {
          pod: 'hsl(var(--resource-pod))',
          'pod-bg': 'hsl(var(--resource-pod-bg))',
          deployment: 'hsl(var(--resource-deployment))',
          'deployment-bg': 'hsl(var(--resource-deployment-bg))',
          service: 'hsl(var(--resource-service))',
          'service-bg': 'hsl(var(--resource-service-bg))',
          configmap: 'hsl(var(--resource-configmap))',
          'configmap-bg': 'hsl(var(--resource-configmap-bg))',
          secret: 'hsl(var(--resource-secret))',
          'secret-bg': 'hsl(var(--resource-secret-bg))',
          node: 'hsl(var(--resource-node))',
          'node-bg': 'hsl(var(--resource-node-bg))',
          namespace: 'hsl(var(--resource-namespace))',
          'namespace-bg': 'hsl(var(--resource-namespace-bg))',
          ingress: 'hsl(var(--resource-ingress))',
          'ingress-bg': 'hsl(var(--resource-ingress-bg))',
          pv: 'hsl(var(--resource-pv))',
          'pv-bg': 'hsl(var(--resource-pv-bg))',
          pvc: 'hsl(var(--resource-pvc))',
          'pvc-bg': 'hsl(var(--resource-pvc-bg))',
        },
        // Utilization colors
        utilization: {
          low: 'hsl(var(--utilization-low))',
          medium: 'hsl(var(--utilization-medium))',
          high: 'hsl(var(--utilization-high))',
          critical: 'hsl(var(--utilization-critical))',
        },
      },
      spacing: {
        // Design system spacing
        'ds-xs': 'var(--space-xs)',
        'ds-sm': 'var(--space-sm)',
        'ds-md': 'var(--space-md)',
        'ds-lg': 'var(--space-lg)',
        'ds-xl': 'var(--space-xl)',
        'ds-2xl': 'var(--space-2xl)',
        'ds-3xl': 'var(--space-3xl)',
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
      transitionDuration: {
        'ds-fast': 'var(--animation-fast)',
        'ds-normal': 'var(--animation-normal)',
        'ds-slow': 'var(--animation-slow)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
