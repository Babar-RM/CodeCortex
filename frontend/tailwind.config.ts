import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#090d16",
        surface: "#111827",
        "surface-card": "#1a2234",
        border: "#26334d",
        primary: {
          50: "#eff6ff",
          100: "#dbeafe",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
        },
        accent: {
          cyan: "#06b6d4",
          violet: "#8b5cf6",
          emerald: "#10b981",
          rose: "#f43f5e",
        },
      },
    },
  },
  plugins: [],
};

export default config;
