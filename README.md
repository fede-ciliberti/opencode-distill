# opencode-distill

An [opencode](https://github.com/anomalyco/opencode) TUI plugin that **distills derailed stretches of a session in place**: rewrites message parts (`text`, `reasoning`, `tool.state.output`) into a compact summary so future turns are shorter and cheaper, without global compaction and without forking.

## What it does

- Rewrites a **contiguous stretch of assistant messages** into a distilled replacement: the first message carries a coherent summary, the rest carry one-line stubs. The message skeleton (ids, order, `step-finish`, `snapshot`, `patch`) stays intact.
- Generates the summary in a **scratch session** under `/tmp/opencode/distill-<ts>` using your default model. No extra credentials.
- Shows a **stretch timeline** and **content-type picker** before distilling, with per-type estimated tokens and a confirmation dialog with honest estimates.
- Keeps the discarded content in an **append-only trace** on disk (`<project>/.opencode/distill/<sessionID>/<ts>.jsonl`) for exact restore.
- Restores any trace via **`/distill-restore`** with a trace selector, including chain-aware reconstruction of overlapping distills.

## What it does NOT do

- Does not delete messages from the middle of a session (that would cascade `step-finish`/`snapshot` and corrupt `/undo`). See ADR 0001.
- Does not touch `snapshot`, `patch`, `step-finish`, `file`, `agent`, `retry`, `compaction`, or `subtask` parts (hard allowlist `text`/`reasoning`/`tool` only).
- Does not touch user messages.
- Does not implement global compaction, prompt caching, semantic selection, multi-session distill, or auto-distill by threshold.
- Does not rebind through `tui.json`'s `keybinds` object (closed set). The optional keybind lives in the plugin's own options tuple.

## Requirements

- opencode `>=1.18.0` with `part.update` (upsert) and `part.delete` (verified on 1.18.32).
- Bun 1.3.2 (runtime for scripts) and TypeScript 5.9. Run `bun install`, not `npm install`.
- This is a **TUI-only** plugin, registered in `tui.json` (not `opencode.json`).
- `bun run build` must run before `bun test`, the entry test imports `dist/tui.js`.

## Installation

### From npm (recommended)

Add it to your `tui.json` (global `~/.config/opencode/tui.json` or project `.opencode/tui.json`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["opencode-distill", { "keybind": "ctrl+alt+j" }]
  ]
}
```

The second tuple element (options) is optional, omit it to run without a keybind. Then restart opencode.

### From a local checkout (for development)

```bash
git clone https://github.com/fede-ciliberti/opencode-distill
cd opencode-distill
bun install
bun run build
```

Then register by absolute path in `tui.json`:

```json
{
  "plugin": [
    ["/path/to/opencode-distill", { "keybind": "ctrl+alt+j" }]
  ]
}
```

## Usage

Both commands appear only inside a session (palette `Ctrl+P`, slash).

### `/distill`, stretch timeline, types, and confirm

`/distill` opens a chain of dialogs:

1. **Stretch timeline**, `Select stretch to distill` (`DialogSelect`): presets `Current turn` / `Last 3` / `Last 5` / `All assistant messages` plus one row per eligible assistant message after the compaction boundary:
   `From <id>: "<preview>"` with `text N · reasoning N · tool N (≈M tok, estimate)`. Picking a `From` row opens a second `DialogSelect` (`Select end of stretch`) to close the range.
2. **Content types**, `Select content types` (`DialogSelect`): presets `Everything (text + reasoning + tool outputs)` / `Everything but tool outputs` / `Reasoning only` / `Tool outputs only` / `Custom…`. `Custom…` opens a `DialogPrompt` (`Content types`, placeholder `e.g. text reasoning tool`); input is parsed by `parseTypeSpec` (tokens in `{text, reasoning, tool}`, space or comma separated).
3. **Confirm**, `Confirm distillation` (`DialogConfirm`) with five lines:
   `Distill <n> assistant messages (<first>..<last>)?` / `text <x> + reasoning <y> + tool <z> chars selected (≈<t> tokens, estimate)` / `Context: <a> chars → <b> chars (≈<s> tokens saved, estimate)` / `Prompt cache: one-time reprice ≈<r> tokens; breaks even after ≈<e> turns (estimate)` / `Originals are preserved in a local trace; /distill-restore undoes this.`

The distill scope is the **selected types only**, the distiller transcript is built already filtered, the plan only rewrites those buckets, and the 500-char minimum is measured over the selected mass. While distilling the toast `Distilling stretch…` is shown; on success: `Distilled <n> messages — ~<saved> chars saved (≈<tok> tokens, estimate)`. The trace is append-only on disk.

If `DialogSelect` is unavailable, the flow falls back to a safe-mode `DialogConfirm` (current turn, all types) instead of silently aborting.

### `/distill-restore`, trace selector and restore

Palette → `Restore last distill` (slash `/distill-restore`):

1. `Select trace to restore` (`DialogSelect`) listing traces as `<YYYY-MM-DD HH:MM>, <n> messages (<status>)` with `description` = stretch ids; corrupt entries appear as `<file> (corrupt)` and are not selectable.
2. `Confirm restore` (`DialogConfirm`): `Restore distillation from <ISO date> (<n> messages)?` / `This rewrites the session back to the original content from the trace.`

On success: `Restore complete — original content is back` and the trace gains a `restored` line.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `keybind` | string | *(none)* | Key that triggers `Distill session stretch`, e.g. `"ctrl+alt+j"`. |

> **Why it is not rebound through `tui.json`'s `keybinds`**: that object is a closed set of built-in commands and rejects unknown keys. Plugin keybinds are configured in the plugin's own options tuple.

## Guards and behavior

Before writing, the plugin checks:

1. **Session route**, the command only acts inside a `session` route.
2. **Allowlist (I4)**, only `text`/`reasoning`/`tool` are ever updated or deleted; any op outside the allowlist makes the plan invalid.
3. **Compaction boundary (I7)**, the stretch must be strictly after the last `compaction` part. The timeline only lists eligible messages; `stretch-behind-compaction` is refused.
4. **Contiguity and role**, the stretch must contain only assistant messages, be contiguous, and not cross a user message.
5. **No summary/compaction inside**, a stretch containing a `summary` message or a `compaction` part is refused.
6. **Mass and type scope**, the selected types must have distillable content (`> 0`) and reach the 500-char minimum over the selected mass; tool parts only count when `completed`/`error` with output.
7. **Busy and re-validation**, writes only when the session is idle (`session.status` idle check at gate and a re-check immediately before `EXECUTE`; appends outside the stretch during the distill window cause abort). Conversation drift is detected by part hashes, any drift aborts with no writes.
8. **Crash safety**, trace is write-ahead (`planned` first, `executing`/`done`/`partial` appended); execution order is `UPDATE`s first, `DELETE`s after, so a mid-batch crash leaves an over-full (never empty) state. Idempotent upserts (`prt_distill_<hash8>` / `prt_stub_<id>`) plus idempotent deletes make retry safe. `/undo` file snapshots stay intact; `restore` is the only way to get original text back.

## Error handling

All user-visible strings below are verbatim from `src/flow.ts` and `src/pure.ts`. The `mapUpdateError` mapping mirrors the sibling plugin.

| Situation | Toast |
|---|---|
| Not in a session | `Open a session first` |
| No messages in session | `No messages to distill` |
| Distillation already running for this session | `A distillation is already running for this session` |
| Custom types input invalid | `Invalid content types — use: text, reasoning, tool` |
| Stretch crosses a user message | `Stretch crosses a user message` |
| Stretch at or before compaction boundary | `Stretch is behind the compaction boundary` |
| Stretch too small | `Stretch too small to be worth distilling (< 500 chars)` |
| No distillable content for chosen types | `No distillable content of the selected types in this stretch` |
| Stretch contains a compaction summary | `Stretch contains a compaction summary` |
| Stretch contains a compaction part | `Stretch contains a compaction part` |
| Stretch empty | `Stretch is empty — nothing to distill` |
| Not enough messages / endpoint not found (range) | verbatim `validation.message` from `selectStretch` |
| Could not read traces (distill) | `Could not read distill traces` |
| Corrupt trace intersecting the stretch (distill) | `A distill trace is corrupted — cannot safely distill this stretch` |
| Distilling | `Distilling stretch…` |
| Could not clean up scratch session | `Could not clean up the scratch session` |
| Distiller returned unparseable or over-budget output | `Distiller returned invalid output — nothing was changed` |
| Internal plan validation failed | `Internal validation failed — nothing was changed` / `Internal validation failed — nothing was changed: <detail>` |
| Could not write trace | `Could not write trace — nothing was changed: <detail>` |
| Session busy at re-check (distill) | `Session is busy — distill aborted before any change` |
| Conversation changed during distillation | `The conversation changed during distillation — nothing was changed` |
| Part write failed, no writes yet | `<mapped> — nothing was changed` |
| Part write failed after some writes | `<mapped> — run /distill-restore to undo` |
| Distill success | `Distilled <n> messages — ~<saved> chars saved (≈<tok> tokens, estimate)` |
| Restore: session busy | `Session is busy — try again when it's idle` |
| Restore: could not read traces | `Could not read distill traces` |
| Restore: no traces | `No distill traces for this session` |
| Restore: all traces corrupted | `All distill traces are corrupted — restore unavailable` |
| Restore: chosen trace missing | `Trace not found — nothing restored` |
| Restore: corrupt trace intersecting the stretch | `A related distill trace is corrupted — restore unavailable for this stretch` |
| Restore: cannot build ops | `Restore cannot proceed — nothing was changed` |
| Restore: part write failed | `<mapped> — Restore incomplete — re-run /distill-restore (it is safe to retry)` |
| Restore success | `Restore complete — original content is back` |

`mapUpdateError` sub-messages (`<mapped>`):

| Cause | Message |
|---|---|
| Session busy (`409`) | `Session was busy — nothing written` |
| Session not found (`404` + `NotFoundError`) | `Session not found — it may have been deleted` |
| Endpoint missing / version mismatch | `This opencode version doesn't support part writes` |
| Other HTTP error | `Update failed (<status>)` |
| Network / no response | `Could not reach opencode server` |

## Limitations

- **Estimates are `chars/4`, not measured.** All token numbers in the timeline and confirm dialog are estimates (`≈N tokens, estimate`); real tokens are per step, not per message, and depend on the provider.
- **Strict providers and reasoning.** Rewriting `reasoning` may not save tokens on providers that drop reasoning without a valid signature (Anthropic, Bedrock). Q2 in `docs/04` is documented as inconclusive, Anthropic returned `credit balance too low` in the isolated test environment, so the delta is not measurable there.
- **Tokens are per step, not per message.** The per-message breakdown in the timeline is an estimate from `chars/4`; only `step-finish.tokens.input` is authoritative and it aggregates by step.
- **Textual timeline, not graphical.** The stretch picker is a `DialogSelect` list, not a graphical timeline. A custom JSX timeline was rejected as an unverified surface.
- **Orphan scratch session on hard crash.** A crash between scratch creation and `finally`-delete can leave a `distill-scratch` session on the server. It is safe to delete manually.
- **Safe-mode fallback.** If `DialogSelect` fails, the flow falls back to a safe-mode `DialogConfirm` (current turn, all types) so the operation remains available.
- **Known finding, `metadata` breaks the next prompt (owner decision pending).** A non-empty `metadata` on a `text` part (and `metadata.preview` on a `tool` part) makes the provider reject the **next** prompt in the distilled session (`UnknownError: messages do not match ModelMessage[] schema`). The store accepts the write (`200`), the rejection happens when building the next prompt. The plugin persists `synthetic` + `metadata` as designed (I2/I3), but the distilled session is not conversable in this environment until the owner decides between marking provenance without `metadata` (e.g. textual prefix) vs. investigating the projector. See `docs/02` end-to-end (task #17 cause probe, 7 arms) and `docs/04` Q5. Tests and QA cases assert dialogs/writes, not the post-distill turn, so this does not affect verification.
- **Compaction boundary fallback.** `tail_start_id` is not written by `session.summarize` in 1.18.32, so the boundary is the session start; rows with `summary:true` or `compaction` parts are still excluded.

## Development

```bash
bun install            # install SDK (devDependency)
bun run build          # compile src -> dist (required before bun test)
bun run typecheck      # tsc over src + tests
bun test               # build + bun test
```

Structure:

- `src/pure.ts`, pure stretch/type selection, plan builder, invariants I1,I8, hashes, estimates, confirm messages, error mapping.
- `src/distill.ts`, prompt, filtered transcript, output parser and budget.
- `src/journal.ts`, append-only JSONL trace, `pristineReconstruct`, `buildRestoreOps`.
- `src/ports.ts`, minimal interfaces the `api`/SDK satisfy without casts.
- `src/flow.ts`, orchestration: distill chain (select timeline, select types, distill, plan, confirm, execute) and restore selector.
- `src/tui.ts`, entry: palette/slash registration, optional keybind, and `api` → `FlowPorts` adapters.

Design, findings, and open questions: [`docs/01-diseño.md`](docs/01-diseño.md), [`docs/02-hallazgos-empiricos.md`](docs/02-hallazgos-empiricos.md), [`docs/03-investigacion-opencode.md`](docs/03-investigacion-opencode.md), [`docs/04-preguntas-abiertas.md`](docs/04-preguntas-abiertas.md). Decisions: [`docs/adr/`](docs/adr/). Manual QA: [`QA.md`](QA.md).

## License

MIT.
