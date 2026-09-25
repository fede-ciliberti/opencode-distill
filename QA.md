# Manual QA — opencode-distill

Checklist to verify the plugin against a real opencode TUI. The automated tests
(`bun test`) cover the pure logic, the flow with fakes, and the SDK contract;
this list covers what can only be seen with the live TUI: dialogs, toasts,
trace files on disk, and re-rendered messages.

All UI copy below is EXACT (from `src/flow.ts` / `src/pure.ts` / `src/tui.ts`).
Do not paraphrase when asserting — match the string verbatim.

## Setup

1. Build the plugin: `bun run build` (produces `dist/tui.js`).
2. Create a scratch dir (NEVER the global config, NEVER a real project):
   ```bash
   mkdir -p /tmp/opencode/qa-distill/.opencode
   cat > /tmp/opencode/qa-distill/.opencode/tui.json << 'EOF'
   {
     "plugin": [
       ["/home/fciliberti/Trabajos/Tools/opencode-plugins/opencode-distill", {}]
     ]
   }
   EOF
   ```
3. Run opencode FROM that dir: `cd /tmp/opencode/qa-distill && opencode`.
   The TUI default model must answer: if `deepseek-v4-flash` does not respond
   under `--pure`-like conditions, switch the session model to
   `litellm/gpt-oss-20b` or `litellm/muse-spark-1.3-contributor`.
4. Drive the TUI via tmux (toasts are NOT readable via SDK; `capture-pane`
   is the instrument):
   ```bash
   tmux new-session -d -s distillqa -x 200 -y 50
   tmux send-keys -t distillqa -l "cd /tmp/opencode/qa-distill && opencode" Enter
   # input:  tmux send-keys -t distillqa -l "<text>" (+ Enter / Escape / C-p)
   # read:   tmux capture-pane -t distillqa -p
   ```
5. Per-case verification is TWO-fold: (1) assert the expected string in the
   capture (toast/dialog), (2) assert state on disk: trace files in
   `/tmp/opencode/qa-distill/.opencode/distill/<sessionID>/<ts>.jsonl` and
   messages re-rendered in the pane after reopening the session.
6. Cleanup at the end: `tmux kill-session -t distillqa`.

> ⚠️ KNOWN FINDING (task #17): a non-empty `metadata` on a text part makes the
> provider reject the NEXT prompt in the distilled session
> (`UnknownError: messages do not match ModelMessage[] schema`). The QA cases
> below check dialogs/toasts/writes (not the post-distill turn), so they are
> unaffected — but if a case needs a post-distill prompt, document the
> rejection rather than faking success.
>
> ✅ FIX VERIFIED (re-retry 2026-09-25): with the task #15 fix (`buildRestoreOps`
> skips non-mutable parts), restore executes end-to-end: toast
> `Restore complete — original content is back`, trace gains the `restored`
> line, originals verbatim back, `prt_distill_*`/`prt_stub_*` gone. Case 17 ✅.

## Cases

Seed session for most cases: 2+ turns with long assistant texts (> 500 chars
of the chosen type per stretch), at least one tool call, at least one turn
with reasoning visible.

- [ ] **1. Commands visible**: inside a session, open the palette (`Ctrl+P`),
  type `distill` → both `Distill session stretch` and `Restore last distill`
  appear.
- [ ] **2. Happy completo via timeline**: palette → `Distill session stretch`
  → dialog `Select stretch to distill` (presets `Current turn` / `Last 3` /
  `Last 5` / `All assistant messages` + rows `From <id>: "<preview>"` with
  `text N · reasoning N · tool N (≈M tok, estimate)`) → pick `Current turn`
  → dialog `Select content types` → pick
  `Everything (text + reasoning + tool outputs)` → toast `Distilling stretch…`
  → dialog `Confirm distillation` with the 5-line message
  (`Distill <n> assistant messages (<first>..<last>)?` /
  `text <x> + reasoning <y> + tool <z> chars selected (≈<t> tokens, estimate)` /
  `Context: <a> chars → <b> chars (≈<s> tokens saved, estimate)` /
  `Prompt cache: one-time reprice ≈<r> tokens; breaks even after ≈<e> turns (estimate)` /
  `Originals are preserved in a local trace; /distill-restore undoes this.`)
  → confirm → toast `Distilled <n> messages — ~<saved> chars saved (≈<tok> tokens, estimate)`
  AND a trace file exists in `.opencode/distill/<sessionID>/<ts>.jsonl`
  (first line status `planned`, last line status `done`).
- [ ] **3. Silent cancel at timeline**: open `/distill`, press `Escape` at
  `Select stretch to distill` → back in session, zero writes (no new file in
  `.opencode/distill/<sessionID>/`), zero error toasts.
- [ ] **4. Silent cancel at end selector**: pick a row `From <id>` → dialog
  `Select end of stretch` → `Escape` → zero writes, zero error toasts.
- [ ] **5. Silent cancel at types**: pick a stretch → dialog
  `Select content types` → `Escape` → zero writes, zero error toasts.
- [ ] **6. Silent cancel at confirm**: pick stretch + types → dialog
  `Confirm distillation` → cancel → zero writes, zero error toasts.
- [ ] **7. Range via rows**: pick a row `From <firstID>` → dialog
  `Select end of stretch` → pick the end row → confirm message shows
  `Distill <n> assistant messages (<firstID>..<lastID>)?` with the exact
  chosen range → confirm → `Distilled <n> messages — …` toast.
- [ ] **8. Custom types invalid**: at `Select content types` pick `Custom…`
  → dialog `Content types` (placeholder `e.g. text reasoning tool`) → type
  `foo` → toast `Invalid content types — use: text, reasoning, tool`,
  zero writes. ✅ VERIFIED 2026-09-25 (tight-loop capture caught the toast;
  trace dir unchanged).
- [ ] **9. Custom types valid**: same dialog → type `text reasoning` →
  proceeds to the `Distilling stretch…` toast and the confirm dialog whose
  breakdown line reads `text <x> + reasoning <y> + tool 0 chars selected …`.
- [ ] **10. Reasoning-only**: pick `Reasoning only` → after confirm, the
  ORIGINAL texts remain visible in the pane, reasoning is absent, the
  distillate part is present (read-back: reopen the session, texts verbatim,
  no reasoning parts).
- [ ] **11. Tool-only**: pick `Tool outputs only` → after confirm, only tool
  outputs are stubbed (`[distilled] <tool> — see distillate`); texts and
  reasoning intact in the pane.
- [ ] **12. Everything but tool outputs**: pick `Everything but tool outputs`
  → after confirm, tool outputs are intact (original output text visible),
  text/reasoning distilled.
- [ ] **13. No distillable content**: pick a stretch + a type preset with no
  mass there (e.g. `Tool outputs only` on a stretch without tool calls) →
  toast `No distillable content of the selected types in this stretch`,
  zero writes.
- [ ] **14. Busy guard**: start a long prompt (model thinking/tool running),
  then run `/distill` from the palette → the flow rejects with the busy
  re-check toast `Session is busy — distill aborted before any change`
  (the initial GATE also idle-checks via `session.status`).
- [ ] **15. Double /distill (mutex)**: invoke `/distill` twice in quick
  succession (second while the first is inside `Distilling stretch…`) →
  second shows toast `A distillation is already running for this session`.
- [ ] **16. Stretch too small**: distill a stretch with < 500 chars of the
  chosen type (e.g. one-word answers) → toast
  `Stretch too small to be worth distilling (< 500 chars)`, zero writes.
- [ ] **17. Restore happy**: after a distill, palette → `Restore last distill`
  → dialog `Select trace to restore` listing the trace
  (`<YYYY-MM-DD HH:MM> — <n> messages (done)`, current = latest preselected)
  → dialog `Confirm restore`
  (  `Restore distillation from <ISO date> (<n> messages)?` /
  `This rewrites the session back to the original content from the trace.`)
  → confirm → toast `Restore complete — original content is back` AND the
  original texts are visible again in the pane.
  ✅ VERIFIED 2026-09-25 (post-fix #15): toast caught, trace `restored`,
  originals verbatim back, distillate/stub gone.
- [ ] **18. Restore with corrupt trace**: `truncate` the `<ts>.jsonl` by hand
  (cut mid-line), then run restore → the entry shows as `<file> (corrupt)`
  disabled in the selector; if it is the only trace → toast
  `All distill traces are corrupted — restore unavailable`.
- [ ] **19. Overlapping re-distill**: distill stretch A, then distill an
  overlapping stretch B (post task #18) → second distill succeeds with input
  = pristine originals (no drift: the distillate summarizes original content,
  not stubs); both traces present in `.opencode/distill/<sessionID>/`.
- [ ] **20. Distill in a compacted session (I7)**: run `/compact` in the QA
  session, then open `/distill` → the timeline lists ONLY post-boundary
  messages; the pre-boundary stretch does not appear (picking near the
  boundary never yields `Stretch is behind the compaction boundary` for a
  listed row).
- [ ] **21. Optional keybind**: set `{ "keybind": "ctrl+alt+j" }` in the
  options tuple of `.opencode/tui.json`, restart, verify the key triggers
  `Distill session stretch`. Remove the option, restart, verify no binding.
- [ ] **22. Outside a session**: on the home screen, open the palette →
  neither `Distill session stretch` nor `Restore last distill` appears
  (both are `enabled` only on the `session` route).

## Success criterion

Commands visible and runnable only inside a session; the full chain
timeline → types → confirm distills exactly the chosen stretch/types with
per-type breakdown + qualified estimates, writes an append-only trace, and
restores verbatim from it; every cancel/guard path leaves zero writes and
shows the exact toast above; `bun run build` stays green.
