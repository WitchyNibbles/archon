---
paths: ["src/**/*.ts", "tests/**/*.ts"]
---
# TypeScript Rules

## Module system

- use NodeNext module resolution (`"moduleResolution": "NodeNext"`)
- all relative imports must include the `.ts` extension
- use `import type` for type-only imports

## Immutability

- never mutate objects or arrays in place; return new copies
- prefer `readonly` arrays and `Readonly<T>` for data structures
- avoid `let` when `const` is sufficient

## Error handling

- never silently swallow errors
- always provide descriptive error messages that aid diagnosis
- use explicit `Error` subclasses for domain errors when the distinction matters

## Type discipline

- no `any`; use `unknown` and narrow explicitly
- exhaustive checks on discriminated unions (use `never` assertion)
- prefer narrowing over casting

## File size

- keep files under 800 lines
- extract utilities when a file grows past ~400 lines
- organize by feature/domain, not by file type

## Tests

- co-locate tests in `tests/` matching the `src/` path structure
- use Node's built-in test runner (`node:test` + `node:assert/strict`) — vitest is NOT installed
- run tests with `node --experimental-strip-types --test tests/*.test.ts`
- write tests first when adding new behavior (red-green-refactor)
