import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Package boundary wall (R2-C), web -> src direction. The root eslint
      // config forbids src/** from importing web/**; this forbids the reverse.
      // web/ is a hard toolchain boundary (React/Vite/Tailwind/Playwright) and
      // must NOT reach back into the core at src/**. Shared contracts flow one
      // way: published from src/forge/ and consumed via a generated/copied type
      // (see web/src/types/), never by importing src/** directly.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // minimatch's `**/src/**` does NOT match `../`-prefixed specifiers,
              // so the relative-escape variants are enumerated explicitly. web/src
              // is 2 levels deep; reaching the repo-root src/ needs at least
              // `../../src/` and one extra `../` per nested dir. Cover depths up to
              // 6 — far beyond any realistic web/src nesting — so the wall has no
              // depth hole as components are added under web/src/**.
              group: [
                "**/src/**",
                "../src/**",
                "../../src/**",
                "../../../src/**",
                "../../../../src/**",
                "../../../../../src/**",
                "../../../../../../src/**",
              ],
              message:
                "web/ must not import from src/** (R2-C package boundary). Consume the forge contract via web/src/types/ (kept in sync with src/forge/), not by importing the core directly.",
            },
          ],
        },
      ],
    },
  },
);
