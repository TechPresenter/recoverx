# Contributing

RecoverX is commercial, source-available software: the code is public, but it is not open source — using it is governed by [LICENSE](../LICENSE). This guide sets the standard
every change is held to — whether it comes from the founder, a contractor, or an
AI coding assistant.

## The one rule

**Recovery software cannot lose data.** A user reaches for this application on
the worst day their storage has had. Every change is judged first on whether it
could make their situation worse.

Concretely, and non-negotiably:

- Source devices are opened read-only. Nothing is ever written to a device being
  recovered.
- Recovery output goes to a different volume. `isOnDifferentVolume()` is a
  precondition, not a suggestion.
- A destination is proven writable by a write probe, not by `fs.access`.
- A failure degrades to a clear message. It never silently produces a truncated
  or corrupt file.

## Definition of done

A change is not complete until all of these hold:

1. `npm run verify` is clean — format, lint, strict type-check, unit tests.
2. `npm run build && npm run test:e2e` is clean.
3. New logic has tests, **including its failure path**.
4. No `TODO`, no placeholder, no unimplemented branch, no commented-out code.
5. Documentation is updated in the same change: [API.md](API.md) for a new
   channel, [DATABASE.md](DATABASE.md) for a schema change, the README table for
   a new module.
6. Every user-facing string exists in **all** locales. A missing key is a compile
   error, by design.

Partial work does not merge. Modules are completed one at a time.

## Workflow

```bash
git checkout -b feature/disk-detection
```

Small, coherent commits. The hooks will stop you from committing unformatted or
lint-failing code, and from pushing a broken type-check or test run.

### Commit messages

Conventional Commits:

```
feat(disk): enumerate physical devices and volumes
fix(logs): count live-tailed records in the footer total
perf(renderer): move Chart.js off the first-paint path
refactor(database): extract migration planning from execution
docs(api): document the logs:query truncation cap
test(settings): cover repair of an invalid persisted value
chore(deps): update Electron to 43.2.0
```

Scopes: `main`, `renderer`, `preload`, `shared`, `database`, `ipc`, `security`,
`logs`, `settings`, `disk`, `scan`, `recovery`, `deps`, `ci`.

The body explains **why**. The diff already shows what.

### Pull requests

Include:

- What changed and why.
- How it was verified — not just "tests pass", but what scenario was exercised.
- Screenshots for UI changes, in **both** light and dark themes.
- Anything deliberately left out, and why.

## Code standards

Full detail in [DEVELOPMENT.md](DEVELOPMENT.md). The essentials:

**Types are strict and inferred from schemas.** Never hand-write a type that
duplicates a Zod schema — infer it, so the two cannot drift.

**Errors are values at boundaries.** Services throw `AppError` with an
`ErrorCode`; the IPC registry serialises it. Nothing throws across a process
boundary.

**The renderer is untrusted.** It is sandboxed, has no Node access, and reaches
the main process only through declared, schema-validated channels. A change that
widens that surface needs a specific justification in the pull request.

**Comments explain why.** If a line needs a comment to explain _what_ it does,
rename something instead. Comments earn their place by capturing a trade-off, a
non-obvious constraint, or a bug that is easy to reintroduce.

**Extract pure logic.** Anything that can be tested without Electron should live
in a module that does not import it. This is why `settings-codec`, `log-parser`
and `migration-plan` exist separately from the services that use them.

## Accessibility

Not optional, and enforced by `eslint-plugin-jsx-a11y`:

- Every interactive element is reachable and operable by keyboard.
- Controls have accessible names; groups use the right roles.
- Focus is visible, and modals trap and restore it.
- Colour is never the only signal — pair it with an icon or text.
- Respect `prefers-reduced-motion` **and** the in-app reduce-motion setting.

## Dependencies

Adding one requires a reason in the pull request. Prefer the platform.

Reject a dependency if it:

- pulls a native addon (it would reintroduce the toolchain requirement removed in
  [ADR-001](ARCHITECTURE.md#adr-001-nodesqlite-over-better-sqlite3));
- lands in the renderer's first-paint path for a non-essential feature;
- carries a licence incompatible with commercial distribution;
- is unmaintained, or is a thin wrapper over something already in the tree.

Everything the application ships today is permissively licensed, and the
recovery engine is the project's own code ([ARCHITECTURE.md › Recovery engine](ARCHITECTURE.md#6-recovery-engine)).
A copyleft component — a GPL recovery tool, even run as a separate process —
needs counsel's agreement before it is designed in. Any new shipped component
must be added to [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) in the same
change.

## Review checklist

- Could this change write to a source device, under any code path?
- What happens when the disk is full, the file is locked, or the device is
  removed mid-operation?
- Does it hold the UI thread? Is a long list virtualised? Is IPC batched?
- Does it widen the renderer's capabilities?
- Are new strings translated? Are new controls keyboard-operable?
- Does the failure path have a test?

## Reporting security issues

Do not open a public issue. Email **info@appsgain.in** with reproduction
steps. Expect an acknowledgement within two business days.
