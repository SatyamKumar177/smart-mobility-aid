import js from "@eslint/js";
import globals from "globals";
export default [
  { ignores: ["node_modules/**", "dist/**"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.vitest,
        React: "readonly",
      },
    },
    rules: { "no-unused-vars": "off" },
  },
];
