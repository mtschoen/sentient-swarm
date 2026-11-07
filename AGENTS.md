# Agent instructions

## Global constraints

- Plain JavaScript ES modules. No TypeScript. No runtime dependencies; `vite` and `playwright` are the only devDependencies (do not add eslint, prettier, vitest or anything else).
- Full-word identifiers (`maximum`, not `max`). No em-dashes (U+2014) anywhere, including docs and comments; use plain hyphens or commas.
- Every source file under about 500 lines.
- No hard-coded machine paths. No wall-clock assertions in tests.
- Commit messages: imperative subject, and end the message with a blank line then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Commands

- `npm run dev`: dev server on 127.0.0.1:5174.
- `npm test`: CPU logic tests via node:test.
- `npm run smoke`: Playwright browser smoke test.
