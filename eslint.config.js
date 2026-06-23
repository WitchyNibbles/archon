// Flat ESLint config (ESLint 9 + typescript-eslint). This is the linter the codebase
// already anticipated via scattered `eslint-disable-next-line @typescript-eslint/*`
// directives. Scope: syntactic (non-type-checked) recommended rules — fast, no
// typed-linting program build. Type-aware rules are a deliberate follow-up.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";

export default tseslint.config(
  {
    // Generated / vendored / build-output paths, plus the managed control-layer
    // hooks (.claude/** is not part of the TS build and is governed separately).
    // web/** is the Forge UI workspace — it ships its own eslint.config.js and
    // its own toolchain; the root linter must not reach in.
    ignores: ["node_modules/**", "coverage/**", "dist/**", "**/*.d.ts", ".claude/**", "web/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Type-aware rules apply only to src/** — that is what tsconfig includes (tests
    // and scripts are excluded), and it is the production surface where typed checks
    // (floating promises, unsafe any, etc.) matter most.
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Package boundary wall (R2-C): src/** MUST NOT import from web/**.
      // The Forge UI workspace (web/) is a hard toolchain boundary — React, Vite,
      // Tailwind, and Playwright live only in web/package.json and must never bleed
      // into archon's lean backend core. A future published src/forge/ contract
      // (data types / event schemas) is the only allowed bridge, and that flows
      // FROM src TO web, never the other direction.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/web/**", "../web/**", "../../web/**"],
              message:
                "src/** must not import from web/**. The Forge UI workspace is a hard package boundary (R2-C). If you need to share types, publish them through src/forge/ and import from there.",
            },
          ],
        },
      ],

      // The high-value type-aware rules (no-floating-promises, no-misused-promises,
      // await-thenable, ...) already pass clean and stay enforced. The rules below are
      // turned off as a documented baseline: they flag pre-existing `any`-flow debt
      // (pg rows, JSON.parse, external payloads) and intentional async-for-interface
      // signatures across a 49k-line codebase not written under typed linting. Burning
      // them down (real narrowing) is a separate hardening initiative; re-enable
      // incrementally as the `any` surface shrinks.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/require-await": "off",
      // Auto-fixable in principle, but `--fix` produced tsc-breaking removals here
      // (no-unnecessary-type-assertion flagged load-bearing casts as redundant).
      // Disabled until the assertions can be reviewed case-by-case.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-duplicate-type-constituents": "off"
    }
  },
  {
    files: ["**/*.ts"],
    plugins: { "unused-imports": unusedImports },
    rules: {
      // TypeScript resolves identifier binding; core no-undef double-reports globals
      // (process, console, URL, ...) and is redundant with the compiler.
      "no-undef": "off",

      // Empty interfaces that extend a single supertype are a deliberate named
      // extension point in this codebase (e.g. ExecuteGapsCommandOptions); allow them.
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],

      // Dead imports are real removable cruft (tsconfig has noUnusedLocals off, so
      // they accumulated). unused-imports/no-unused-imports is auto-fixable, so
      // `eslint --fix` strips them. The base rule is delegated to the plugin.
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_"
        }
      ]
    }
  }
);
