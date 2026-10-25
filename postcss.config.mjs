import legacyCompat from "./postcss-legacy-compat.cjs";

const config = {
  // The legacy-compat step runs after Tailwind and only adds fallbacks for
  // older browsers (Samsung Internet, Android WebView, smart-TV browsers) —
  // see postcss-legacy-compat.cjs. Modern rendering is unchanged.
  plugins: ["@tailwindcss/postcss", legacyCompat()],
};

export default config;
