import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#152035",
        navy: "#111D35",
        mint: "#DFF8EF",
        brand: "#3563F6"
      },
      boxShadow: {
        soft: "0 20px 60px rgba(26, 49, 92, 0.11)",
        card: "0 12px 34px rgba(27, 48, 91, 0.08)"
      }
    }
  },
  plugins: []
};

export default config;
