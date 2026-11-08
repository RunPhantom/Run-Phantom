import animate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
        display: ["var(--font-display)"],
      },
      fontSize: {
        label: "10px",
        default: "12px",
        message: "14px",
        header: "21px",
      },
      borderColor: {
        border: "var(--border)",
      },
      borderRadius: {
        none: "0",
        control: "var(--rp-radius-control)",
        sm: "var(--rp-r-xs)",
        DEFAULT: "var(--rp-r-sm)",
        md: "var(--rp-r-md)",
        lg: "var(--rp-r-lg)",
        xl: "var(--rp-r-xl)",
        "2xl": "var(--rp-r-2xl)",
        "3xl": "var(--rp-r-2xl)",
        full: "var(--rp-r-full)",
      },
      boxShadow: {
        e1: "var(--rp-e1)",
        e2: "var(--rp-e2)",
        e3: "var(--rp-e3)",
        e4: "var(--rp-e4)",
        sm: "var(--rp-e1)",
        DEFAULT: "var(--rp-e1)",
        md: "var(--rp-e2)",
        lg: "var(--rp-e2)",
        xl: "var(--rp-e3)",
        "2xl": "var(--rp-e4)",
      },

      backgroundColor: {
        background: "var(--background)",
        muted: "var(--muted)",
      },
      textColor: {
        foreground: "var(--foreground)",
        "muted-foreground": "var(--muted-foreground)",
        primary: "var(--primary)",
      },
      transitionTimingFunction: {
        standard: "var(--rp-ease-standard)",
        spring: "var(--rp-ease-spring)",
      },
      transitionDuration: {
        250: "250ms",
        350: "350ms",
      },
      keyframes: {
        "rp-fade-rise": {
          from: { opacity: "0", transform: "translateY(var(--rp-rise-distance))" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "rp-pop-in": {
          from: { opacity: "0", transform: "translateY(-4px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "fade-rise": "rp-fade-rise var(--rp-dur-rise) var(--rp-ease-standard) both",
        "pop-in": "rp-pop-in var(--rp-dur-spring) var(--rp-ease-spring) both",
      },
      colors: {
        rp: {
          blue: "var(--rp-blue)",
          "blue-hover": "var(--rp-blue-hover)",
          "blue-active": "var(--rp-blue-active)",
          ink: "var(--rp-ink)",
          "ink-soft": "var(--rp-ink-soft)",
          "ink-muted": "var(--rp-ink-muted)",
          "ink-subtle": "var(--rp-ink-subtle)",
          "ink-faint": "var(--rp-ink-faint)",
          line: "var(--rp-line)",
          "line-muted": "var(--rp-line-muted)",
          "line-strong": "var(--rp-line-strong)",
          wash: "var(--rp-wash)",
          "wash-border": "var(--rp-wash-border)",
          canvas: "var(--rp-canvas)",
          "canvas-blue": "var(--rp-canvas-blue)",
          surface: "var(--rp-surface)",
          "row-hover": "var(--rp-row-hover)",
          index: "var(--rp-index)",
          success: "var(--rp-success)",
          "success-soft": "var(--rp-success-soft)",
          "success-border": "var(--rp-success-border)",
          danger: "var(--rp-danger)",
          "danger-hover": "var(--rp-danger-hover)",
          "danger-soft": "var(--rp-danger-soft)",
          "danger-border": "var(--rp-danger-border)",
          warning: "var(--rp-warning)",
          "warning-soft": "var(--rp-warning-soft)",
          "warning-border": "var(--rp-warning-border)",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
    },
  },
  plugins: [animate],
};
