import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["node_modules/", "assets/vendor/", "coverage/"]),

  {
    files: ["**/*.{js,mjs,ts}"],
    plugins: { js },
    extends: ["js/recommended"],
  },

  tseslint.configs.recommended,

  // Everything that runs under Node: the server, tools, tests, scripts, the launcher.
  {
    files: [
      "src/**/*.ts",
      "test/**/*.ts",
      "scripts/**/*.{ts,mjs}",
      "pi/**/*.ts",
      "hooks/**/*.ts",
      "mcp/**/*.mjs",
      "eslint.config.js",
    ],
    languageOptions: { globals: globals.node },
  },

  // The browser runtime is plain ES modules served as-is, so it gets browser globals.
  {
    files: ["assets/runtime/**/*.mjs", "assets/editor/**/*.mjs"],
    languageOptions: { globals: globals.browser },
  },
]);
