# value2design-token README

✨ A VS Code extension for Tailwind CSS v4 — select raw CSS values (#1E90FF, 16px, etc.), instantly replace them with design tokens (var(--color-primary)), and auto-create new tokens with smart naming when missing.

## Important

This extension only supports global design tokens (:root / @theme) and their theme overrides (e.g. .dark, [data-theme]).
Variables defined outside this scope are treated as non-standard and will be ignored.

## Development

### Testing

This extension includes comprehensive unit tests for the indexer functionality:

```bash
# Run all tests (including linting and compilation)
pnpm test

# Run only indexer unit tests
pnpm run test:indexer

# Run unit tests (alias for test:indexer)
pnpm run test:unit

# Compile tests without running
pnpm run compile-tests

# Watch mode for test compilation
pnpm run watch-tests
```

### Available Scripts

- `pnpm run compile` - Compile the extension using webpack
- `pnpm run watch` - Watch mode for development
- `pnpm run package` - Build production package
- `pnpm run package:vsix` - Create VSIX package for installation
- `pnpm run install:local` - Install extension locally in Cursor
- `pnpm run install:local:vscode` - Install extension locally in VS Code
- `pnpm run test:indexer` - Run indexer unit tests
- `pnpm run test:unit` - Run all unit tests
- `pnpm run lint` - Run ESLint on source code
