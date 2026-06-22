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
    ignores: ["node_modules/**", "coverage/**", "dist/**", "**/*.d.ts", ".claude/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
