import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "playwright-report/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "preserve-caught-error": "off" } },
  {
    files: ["apps/demo-lab/**/*.js"],
    languageOptions: { globals: { document: "readonly" } },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
  },
);
