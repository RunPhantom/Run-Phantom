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
      colors: {
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
