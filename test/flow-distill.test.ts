// Failing-first para runDistillFlow GATE→REPORT (task #14b).
// Importa de ../src/flow.js y ../src/pure.js (regla dura).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDistillFlow, __resetDistillMutexForTests } from "../src/flow.js"
import { appendPlanned as journalAppendPlanned, appendStatus as journalAppendStatus, latestTrace as journalLatestTrace, readTraces as journalReadTraces } from "../src/journal.js"
import type { AppendPlannedResult, AppendStatusResult, LatestTraceResult, ReadTrace, ReadTracesResult } from "../src/journal.js"
import type { FlowPorts, SelectOption, ServerMessage, SessionStatusLike, ToastVariant, UpdatePartArgs } from "../src/ports.js"
import type { MessageLike, PartLike, TraceEntry, TypeFilter } from "../src/pure.js"

// --- helpers de mensajes/partes ---

function userMessage(id: string, created: number): MessageLike {
  return { id, role: "user", time: { created }, parts: [] }
}

function assistantMessage(id: string, created: number, parts: readonly PartLike[] = []): MessageLike {
  return { id, role: "assistant", time: { created }, parts }
}

function textPart(id: string, messageID: string, text: string): PartLike {
  return { id, sessionID: "s1", messageID, type: "text", text }
}

function reasoningPart(id: string, messageID: string, text: string): PartLike {
  return { id, sessionID: "s1", messageID, type: "reasoning", text }
}

function toolPart(id: string, messageID: string, output: string): PartLike {
  return { id, sessionID: "s1", messageID, type: "tool", state: { status: "completed", output } }
}

function bigText(id: string, messageID: string, chars = 600): PartLike {
  return textPart(id, messageID, "x".repeat(chars))
}

function makeMessages(): MessageLike[] {
  const a1Parts: PartLike[] = [bigText("p-a1", "a1", 600)]
  const a2Parts: PartLike[] = [bigText("p-a2", "a2", 600)]
  const a3Parts: PartLike[] = [bigText("p-a3", "a3", 600)]
  return [
    userMessage("u1", 1),
    assistantMessage("a1", 2, a1Parts),
    assistantMessage("a2", 3, a2Parts),
    assistantMessage("a3", 4, a3Parts),
  ]
}

function validDistillRaw(ids: readonly string[]): string {
  const stubs = ids.map((_, i) => `${i + 1}: stub ${i + 1}`).join("\n")
  return `<distillate>\n## Outcome\nok\n## Ruled out\n- h — e\n## Key facts\n- f — w\n## Open\n- none\n</distillate>\n<stubs>\n${stubs}\n</stubs>`
}

// --- FakePorts con recording ---

type ScratchModel = { providerID: string; modelID: string }

class FakePorts implements FlowPorts {
  selectAvailable?: boolean
  // state
  routeName = "session"
  sessionIDValue: string | undefined = "s1"
  directoryValue: string
  nowValue = 1700000000000
  stateMessagesValue: readonly MessageLike[] = []
  serverMessagesValue: readonly ServerMessage[] = []
  partsByMessageValue: Map<string, readonly PartLike[]> = new Map()
  stateStatusValue: SessionStatusLike | undefined = { type: "idle" }
  serverStatusMapValue: Readonly<Record<string, SessionStatusLike | undefined>> = {}
  scratchReplyText = validDistillRaw(["a1", "a2", "a3"])
  scratchModelValue: ScratchModel = { providerID: "anthropic", modelID: "claude-sonnet-4" }
  scratchSessions = new Map<string, string>()
  scratchSeq = 0

  // recording
  calls: string[] = []
  toasts: Array<{ variant: string; message: string }> = []
  selectCalls: Array<{ title: string; count: number }> = []
  confirmCalls: Array<{ title: string; message: string }> = []
  promptCalls: Array<{ title: string; placeholder: string }> = []
  updateCalls: Array<{ partID: string }> = []
  deleteCalls: Array<{ partID: string }> = []
  appendPlannedCalls = 0
  appendStatusCalls: string[] = []
  createScratchCalls = 0
  promptScratchCalls = 0
  deleteScratchCalls = 0
  fetchServerMessagesCalls = 0
  fetchServerStatusCalls = 0

  // scripted behaviors
  selectAuto: Array<"first" | "cancel" | "custom" | number> = []
  selectIndex = 0
  promptAuto: Array<{ kind: "value"; value: string } | { kind: "cancel" }> = []
  promptIndex = 0
  confirmAuto: Array<"confirm" | "cancel"> = []
  confirmIndex = 0
  updateScript: Array<{ ok: true } | { ok: false; error: unknown; status?: number }> = []
  deleteScript: Array<{ ok: true } | { ok: false; error: unknown; status?: number }> = []
  readTracesValue: ReadTrace[] = []
  // for drift simulation: mutate parts after snapshot
  mutatePartsAfterSnapshot?: () => void

  constructor(directory: string) {
    this.directoryValue = directory
  }

  listStateMessages(_sessionID: string): readonly MessageLike[] {
    this.calls.push("listStateMessages")
    return this.stateMessagesValue
  }
  async fetchServerMessages(_sessionID: string, _limit: number): Promise<readonly ServerMessage[]> {
    this.calls.push("fetchServerMessages")
    this.fetchServerMessagesCalls += 1
    return this.serverMessagesValue
  }
  readParts(messageID: string): readonly PartLike[] {
    this.calls.push(`readParts:${messageID}`)
    return this.partsByMessageValue.get(messageID) ?? []
  }
  readStateStatus(_sessionID: string): SessionStatusLike | undefined {
    this.calls.push("readStateStatus")
    return this.stateStatusValue
  }
  async fetchServerStatus(): Promise<Readonly<Record<string, SessionStatusLike | undefined>>> {
    this.calls.push("fetchServerStatus")
    this.fetchServerStatusCalls += 1
    return this.serverStatusMapValue
  }
  async updatePart(args: UpdatePartArgs): Promise<import("../src/ports.js").PartWriteOutcome> {
    this.calls.push(`updatePart:${args.partID}`)
    this.updateCalls.push({ partID: args.partID })
    const script = this.updateScript.shift()
    if (script !== undefined && !script.ok) return { ok: false, error: script.error, status: script.status }
    return { ok: true }
  }
  async deletePart(args: import("../src/ports.js").DeletePartArgs): Promise<import("../src/ports.js").PartWriteOutcome> {
    this.calls.push(`deletePart:${args.partID}`)
    this.deleteCalls.push({ partID: args.partID })
    const script = this.deleteScript.shift()
    if (script !== undefined && !script.ok) return { ok: false, error: script.error, status: script.status }
    return { ok: true }
  }
  async createScratch(directory: string, title: string): Promise<string> {
    this.calls.push(`createScratch:${title}`)
    this.createScratchCalls += 1
    this.scratchSeq += 1
    const id = `scratch-${this.scratchSeq}`
    this.scratchSessions.set(id, directory)
    void directory
    return id
  }
  async promptScratch(_sessionID: string, _directory: string, _text: string): Promise<{ text: string; model: ScratchModel }> {
    this.calls.push("promptScratch")
    this.promptScratchCalls += 1
    if (this.mutatePartsAfterSnapshot) this.mutatePartsAfterSnapshot()
    return { text: this.scratchReplyText, model: this.scratchModelValue }
  }
  async deleteScratch(_sessionID: string, _directory: string): Promise<void> {
    this.calls.push("deleteScratch")
    this.deleteScratchCalls += 1
  }
  appendPlanned(entry: TraceEntry, ts: number): AppendPlannedResult {
    this.calls.push("appendPlanned")
    this.appendPlannedCalls += 1
    return journalAppendPlanned(this.directoryValue, entry, ts)
  }
  appendStatus(sessionID: string, ts: number, status: string, at: number): AppendStatusResult {
    this.calls.push(`appendStatus:${status}`)
    this.appendStatusCalls.push(status)
    return journalAppendStatus(this.directoryValue, sessionID, ts, status, at)
  }
  readTraces(sessionID: string): ReadTracesResult {
    this.calls.push("readTraces")
    if (this.readTracesValue.length > 0) {
      const hasCorrupt = this.readTracesValue.some((t) => !t.ok)
      if (hasCorrupt) return { ok: true, traces: this.readTracesValue }
    }
    return journalReadTraces(this.directoryValue, sessionID)
  }
  latestTrace(sessionID: string): LatestTraceResult {
    return journalLatestTrace(this.directoryValue, sessionID)
  }
  confirmDialog(title: string, message: string, onConfirm: () => void, onCancel: () => void): void {
    this.calls.push(`confirmDialog:${title}`)
    this.confirmCalls.push({ title, message })
    const auto = this.confirmAuto[this.confirmIndex++] ?? "confirm"
    if (auto === "confirm") onConfirm()
    else onCancel()
  }
  promptDialog(title: string, placeholder: string, onValue: (value: string) => void, onCancel: () => void): void {
    this.calls.push(`promptDialog:${title}`)
    this.promptCalls.push({ title, placeholder })
    const auto = this.promptAuto[this.promptIndex++] ?? { kind: "value", value: "text reasoning tool" }
    if (auto.kind === "value") onValue(auto.value)
    else onCancel()
  }
  selectDialog<T>(title: string, options: readonly SelectOption<T>[], current: T | undefined, onSelect: (value: T) => void, onCancel: () => void): void {
    this.calls.push(`selectDialog:${title}`)
    this.selectCalls.push({ title, count: options.length })
    void current
    const auto = this.selectAuto[this.selectIndex++]
    if (auto === "cancel" || auto === undefined) {
      // default: pick first
      if (auto === "cancel") { onCancel(); return }
      const first = options[0]
      if (first !== undefined) onSelect(first.value)
      else onCancel()
      return
    }
    if (typeof auto === "number") {
      const opt = options[auto]
      if (opt !== undefined) onSelect(opt.value)
      else onCancel()
      return
    }
    if (auto === "first") {
      const first = options[0]
      if (first !== undefined) onSelect(first.value)
      else onCancel()
      return
    }
    if (auto === "custom") {
      // find Custom… option
      const custom = options.find((o) => (o.title as string).includes("Custom"))
      if (custom !== undefined) onSelect(custom.value)
      else onCancel()
      return
    }
    onCancel()
  }
  toast(variant: ToastVariant, message: string): void {
    this.calls.push(`toast:${variant}:${message.slice(0, 30)}`)
    this.toasts.push({ variant, message })
  }
  currentRouteName(): string { return this.routeName }
  currentSessionID(): string | undefined { return this.sessionIDValue }
  readDirectory(): string { return this.directoryValue }
  now(): number { return this.nowValue }
}

let tmpDirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-distill-"))
  tmpDirs.push(dir)
  return dir
}

function setupHappyPorts(dir: string): FakePorts {
  const ports = new FakePorts(dir)
  const messages = makeMessages()
  ports.stateMessagesValue = messages
  // partsByMessage: each assistant message has its big text part
  for (const m of messages) {
    if (m.role === "assistant") {
      ports.partsByMessageValue.set(m.id, [...m.parts])
    }
  }
  // default: select current-turn (first preset), then Everything (first type), then confirm
  ports.selectAuto = ["first", "first"]
  ports.confirmAuto = ["confirm"]
  ports.scratchReplyText = validDistillRaw(["a2", "a3"]) // current-turn = a2,a3? Actually last user is u1, so current-turn = a1,a2,a3 all? Let's see: lastUserIndex = 0, so start 1..end 2 => a1,a2,a3. So need 3 stubs.
  // For current-turn with 3 messages, need 3 stubs
  ports.scratchReplyText = validDistillRaw(["a1", "a2", "a3"])
  return ports
}

beforeEach(() => { __resetDistillMutexForTests() })
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
  __resetDistillMutexForTests()
})

async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0))
  await new Promise<void>((r) => setTimeout(r, 0))
  await new Promise<void>((r) => setTimeout(r, 50))
}

describe("runDistillFlow", () => {
  test("happy path: step order and success toast", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    runDistillFlow(ports)
    await flush()
    // should have toasts: Distilling… and success
    expect(ports.toasts.some((t) => t.variant === "info" && t.message.includes("Distilling"))).toBe(true)
    expect(ports.toasts.some((t) => t.variant === "success" && t.message.includes("Distilled"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(1)
    expect(ports.appendStatusCalls).toContain("executing")
    expect(ports.appendStatusCalls).toContain("done")
    // updates before deletes
    const updateIdx = ports.calls.findIndex((c) => c.startsWith("updatePart"))
    const deleteIdx = ports.calls.findIndex((c) => c.startsWith("deletePart"))
    if (updateIdx !== -1 && deleteIdx !== -1) expect(updateIdx).toBeLessThan(deleteIdx)
    // distillate.model populated: check trace file has model
    const { readTraces } = await import("../src/journal.js")
    const traces = readTraces(dir, "s1")
    expect(traces.ok).toBe(true)
    if (!traces.ok) return
    expect(traces.traces.length).toBe(1)
    const first = traces.traces[0]
    expect(first?.ok).toBe(true)
    if (!first?.ok) return
    expect(first.entry.distillate.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    // step order: GATE → LOAD → SELECT → DISTILL → PLAN → SIMULATE → CONFIRM → RE-VALID → TRACE → EXECUTE → REPORT
    // verify select before promptScratch before confirm before appendPlanned
    const selIdx = ports.calls.findIndex((c) => c.startsWith("selectDialog"))
    const promptIdx = ports.calls.findIndex((c) => c === "promptScratch")
    const confirmIdx = ports.calls.findIndex((c) => c.startsWith("confirmDialog"))
    const plannedIdx = ports.calls.findIndex((c) => c === "appendPlanned")
    expect(selIdx).toBeLessThan(promptIdx)
    expect(promptIdx).toBeLessThan(confirmIdx)
    expect(confirmIdx).toBeLessThan(plannedIdx)
  })

  test("cancel at stretch selection → silent return, zero writes", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.selectAuto = ["cancel"]
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts).toHaveLength(0)
    expect(ports.appendPlannedCalls).toBe(0)
    expect(ports.createScratchCalls).toBe(0)
  })

  test("cancel at type selection → silent return", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.selectAuto = ["first", "cancel"]
    runDistillFlow(ports)
    await flush()
    expect(ports.appendPlannedCalls).toBe(0)
    expect(ports.toasts).toHaveLength(0)
  })

  test("cancel at confirm → silent return", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.confirmAuto = ["cancel"]
    runDistillFlow(ports)
    await flush()
    expect(ports.appendPlannedCalls).toBe(0)
    expect(ports.toasts).toHaveLength(1) // Distilling toast still?
    // Actually Distilling toast happens before confirm, so 1 info toast
    expect(ports.toasts[0]?.variant).toBe("info")
  })

  test("Custom invalid → toast error and return", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.selectAuto = ["first", "custom"]
    ports.promptAuto = [{ kind: "value", value: "invalid_type" }]
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("Invalid content types"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(0)
  })

  test("Custom valid → proceeds", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.selectAuto = ["first", "custom"]
    ports.promptAuto = [{ kind: "value", value: "text" }]
    // need to adjust scratch reply to match types? still 3 messages
    runDistillFlow(ports)
    await flush()
    expect(ports.appendPlannedCalls).toBe(1)
  })

  test("range in two steps: From row → second dialog for END", async () => {
    const dir = freshDir()
    const ports = new FakePorts(dir)
    const messages = makeMessages()
    ports.stateMessagesValue = messages
    for (const m of messages) if (m.role === "assistant") ports.partsByMessageValue.set(m.id, [...m.parts])
    // build options: presets 4 + rows 3 = 7 options. Row indices: 4,5,6
    // pick row 4 (From a1) then second pick row 5 (From a2) => range a1..a2
    ports.selectAuto = [4, 5, "first"]
    ports.confirmAuto = ["confirm"]
    ports.scratchReplyText = validDistillRaw(["a1", "a2"])
    runDistillFlow(ports)
    await flush()
    expect(ports.selectCalls).toHaveLength(3) // stretch, end, types
    expect(ports.appendPlannedCalls).toBe(1)
  })

  test("No distillable content of selected types → toast", async () => {
    const dir = freshDir()
    const ports = new FakePorts(dir)
    // only text parts, but select tool only
    const a1: PartLike = bigText("p-a1", "a1", 600)
    const messages: MessageLike[] = [userMessage("u1", 1), assistantMessage("a1", 2, [a1]), assistantMessage("a2", 3, [bigText("p-a2", "a2", 600)])]
    ports.stateMessagesValue = messages
    ports.partsByMessageValue.set("a1", [a1])
    ports.partsByMessageValue.set("a2", [bigText("p-a2", "a2", 600)])
    // pick current-turn (a1,a2) and Tool only (index 3 in type options: 0 Everything,1 Everything but tool,2 Reasoning only,3 Tool only)
    ports.selectAuto = ["first", 3]
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("No distillable content"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(0)
  })

  test("busy at confirm re-check → abort", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    // mutate status to busy after distill but before re-valid: use mutate hook to change status
    const origPrompt = ports.promptScratch.bind(ports)
    ports.promptScratch = async (sid, d, text) => {
      const res = await origPrompt(sid, d, text)
      ports.stateStatusValue = { type: "busy" }
      return res
    }
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("Session is busy"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(0)
  })

  test("internal drift → abort", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.mutatePartsAfterSnapshot = () => {
      // change a part inside stretch
      const parts = ports.partsByMessageValue.get("a1")
      if (parts && parts[0]) {
        ports.partsByMessageValue.set("a1", [{ ...parts[0], text: "drifted content " + "x".repeat(600) }])
      }
    }
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("conversation changed"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(0)
  })

  test("external append → abort", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.mutatePartsAfterSnapshot = () => {
      // add a new message outside stretch
      const extra = assistantMessage("a99", 99, [bigText("p-a99", "a99", 600)])
      ports.stateMessagesValue = [...ports.stateMessagesValue, extra]
      ports.partsByMessageValue.set("a99", [...extra.parts])
    }
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("conversation changed") || t.message.includes("Session is busy") || t.message.includes("nothing was changed"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(0)
  })

  test("parse fail → zero writes and error toast", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.scratchReplyText = "garbage without tags"
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("Distiller returned invalid output"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(0)
    expect(ports.updateCalls).toHaveLength(0)
    expect(ports.deleteCalls).toHaveLength(0)
    expect(ports.deleteScratchCalls).toBe(1)
  })

  test("mid-batch fail → partial + toast with mapUpdateError", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    // make second update fail
    ports.updateScript = [{ ok: true }, { ok: false, error: { name: "NotFoundError", data: { message: "gone" } }, status: 404 }]
    runDistillFlow(ports)
    await flush()
    expect(ports.appendStatusCalls).toContain("partial")
    expect(ports.toasts.some((t) => t.message.includes("run /distill-restore to undo"))).toBe(true)
    // deletes should not run after failure
    expect(ports.deleteCalls).toHaveLength(0)
  })

  test("first op fail → nothing was changed (no partial)", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.updateScript = [{ ok: false, error: new Error("network down") }]
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("nothing was changed"))).toBe(true)
    expect(ports.appendStatusCalls).not.toContain("partial")
    expect(ports.appendStatusCalls).toContain("executing")
  })

  test("re-entrant mutex → toast info and return", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    // first call will take mutex; second call immediately should hit mutex
    // make first call hang at promptScratch
    let resolvePrompt: (v: { text: string; model: ScratchModel }) => void = () => {}
    const origPrompt = ports.promptScratch.bind(ports)
    ports.promptScratch = (sid, d, text) => new Promise<{ text: string; model: ScratchModel }>((resolve) => { resolvePrompt = resolve })
    runDistillFlow(ports)
    await new Promise<void>((r) => setTimeout(r, 20))
    const ports2 = ports
    // second invocation with same sessionID should hit mutex
    runDistillFlow(ports2)
    await flush()
    expect(ports2.toasts.some((t) => t.message.includes("already running"))).toBe(true)
    // release first
    resolvePrompt({ text: validDistillRaw(["a1", "a2", "a3"]), model: { providerID: "anthropic", modelID: "claude-sonnet-4" } })
    await flush()
  })

  test("corrupt trace → warn and return", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.readTracesValue = [{ ok: false, reason: "corrupt", file: "/tmp/corrupt.jsonl", message: "bad" }]
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("corrupted"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(0)
  })

  test("distillate.model populated from scratch", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.scratchModelValue = { providerID: "openai", modelID: "gpt-4o" }
    runDistillFlow(ports)
    await flush()
    const { readTraces } = await import("../src/journal.js")
    const traces = readTraces(dir, "s1")
    expect(traces.ok).toBe(true)
    if (!traces.ok) return
    const first = traces.traces[0]
    expect(first?.ok).toBe(true)
    if (!first?.ok) return
    expect(first.entry.distillate.model).toEqual({ providerID: "openai", modelID: "gpt-4o" })
  })

  test("route not session → toast info", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.routeName = "home"
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("Open a session"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(0)
  })

  test("sessionID missing → toast info", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.sessionIDValue = undefined
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("Open a session"))).toBe(true)
  })

  test("stretch too small → toast", async () => {
    const dir = freshDir()
    const ports = new FakePorts(dir)
    const smallPart = textPart("p-a1", "a1", "tiny")
    const messages: MessageLike[] = [userMessage("u1", 1), assistantMessage("a1", 2, [smallPart])]
    ports.stateMessagesValue = messages
    ports.partsByMessageValue.set("a1", [smallPart])
    ports.selectAuto = ["first", "first"]
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("too small") || t.message.includes("500"))).toBe(true)
  })

  test("stretch crosses user message → toast", async () => {
    const dir = freshDir()
    const ports = new FakePorts(dir)
    const a1 = assistantMessage("a1", 2, [bigText("p-a1", "a1", 600)])
    const a2 = assistantMessage("a2", 4, [bigText("p-a2", "a2", 600)])
    const messages: MessageLike[] = [userMessage("u1", 1), a1, userMessage("u2", 3), a2]
    ports.stateMessagesValue = messages
    ports.partsByMessageValue.set("a1", [...a1.parts])
    ports.partsByMessageValue.set("a2", [...a2.parts])
    // range a1..a2 crosses user u2
    // need to select range via From rows: pick From a1 (index 4) then From a2 (index 5) => range a1..a2
    ports.selectAuto = [4, 5, "first"]
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("user message"))).toBe(true)
  })

  test("scratch cleanup failure → warning toast", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.deleteScratch = async () => { throw new Error("cleanup fail") }
    // need to make deleteScratch throw but still record
    const origDelete = ports.deleteScratch.bind(ports)
    void origDelete
    ports.deleteScratch = async (_sid: string, _dir: string) => {
      ports.calls.push("deleteScratch")
      ports.deleteScratchCalls += 1
      throw new Error("cleanup fail")
    }
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("Could not clean up"))).toBe(true)
  })

  test("GATE idle: session busy al inicio → refuse sin writes", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.stateStatusValue = { type: "busy" }
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("Session is busy — try again when it's idle"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(0)
    expect(ports.createScratchCalls).toBe(0)
  })

  test("GATE idle: retry al inicio → refuse sin writes", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.stateStatusValue = { type: "retry" }
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("Session is busy — try again when it's idle"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(0)
  })

  test("safe-mode: sin selector → confirm con current-turn + all types", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.selectAvailable = false
    runDistillFlow(ports)
    await flush()
    expect(ports.selectCalls).toHaveLength(0)
    expect(ports.confirmCalls.some((c) => c.message.includes("Distill the current turn with all content types?"))).toBe(true)
    expect(ports.toasts.some((t) => t.variant === "success" && t.message.includes("Distilled"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(1)
  })

  test("safe-mode: cancel en el confirm → retorno silencioso", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.selectAvailable = false
    ports.confirmAuto = ["cancel"]
    runDistillFlow(ports)
    await flush()
    expect(ports.appendPlannedCalls).toBe(0)
    expect(ports.createScratchCalls).toBe(0)
  })

  test("top-level catch: throw crudo del puerto → toast genérico, sin rejection", async () => {
    const dir = freshDir()
    const ports = setupHappyPorts(dir)
    ports.listStateMessages = (_sessionID: string): readonly MessageLike[] => {
      throw new Error("boom crudo")
    }
    runDistillFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message.includes("Distill failed — nothing was changed"))).toBe(true)
  })

  test("re-distill with previous trace (pristine != current) → plan targets current parts, no I8 abort", async () => {
    const dir = freshDir()
    const ports = new FakePorts(dir)
    // Estado CURRENT ya destilado: partes creadas por una traza previa + una parte regular.
    const distillOld: PartLike = { id: "prt_distill_OLD", sessionID: "s1", messageID: "a1", type: "text", text: "d".repeat(600), synthetic: true, metadata: { distilled: true, traceRef: "old" } }
    const stubA2: PartLike = { id: "prt_stub_a2", sessionID: "s1", messageID: "a2", type: "text", text: "s".repeat(600), synthetic: true, metadata: { stub: true, traceRef: "old" } }
    const extraA2: PartLike = textPart("p-extra-a2", "a2", "e".repeat(600))
    const stubA3: PartLike = { id: "prt_stub_a3", sessionID: "s1", messageID: "a3", type: "text", text: "s".repeat(600), synthetic: true, metadata: { stub: true, traceRef: "old" } }
    const messages: MessageLike[] = [
      userMessage("u1", 1),
      assistantMessage("a1", 2, [distillOld]),
      assistantMessage("a2", 3, [stubA2, extraA2]),
      assistantMessage("a3", 4, [stubA3]),
    ]
    ports.stateMessagesValue = messages
    ports.partsByMessageValue.set("a1", [distillOld])
    ports.partsByMessageValue.set("a2", [stubA2, extraA2])
    ports.partsByMessageValue.set("a3", [stubA3])
    // Traza previa T1: originales distintos del estado actual → pristine != current.
    const prevEntry: TraceEntry = {
      version: 1,
      sessionID: "s1",
      createdAt: 1699999999000,
      stretch: ["a1", "a2", "a3"],
      originals: [
        { messageID: "a1", part: textPart("p-a1", "a1", "o".repeat(600)) },
        { messageID: "a2", part: textPart("p-a2", "a2", "o".repeat(600)) },
        { messageID: "a3", part: textPart("p-a3", "a3", "o".repeat(600)) },
      ],
      createdPartIDs: ["prt_distill_OLD", "prt_stub_a2", "prt_stub_a3"],
      plan: [],
      distillate: { summary: "old summary", stubs: {}, model: { providerID: "anthropic", modelID: "claude-sonnet-4" } },
      status: "planned",
    }
    const seeded = journalAppendPlanned(dir, prevEntry, 1699999999000)
    expect(seeded.ok).toBe(true)
    ports.selectAuto = ["first", "first"]
    ports.confirmAuto = ["confirm"]
    ports.scratchReplyText = validDistillRaw(["a1", "a2", "a3"])
    runDistillFlow(ports)
    await flush()
    // Sin abort de I8: llega a EXECUTE y reporta éxito.
    expect(ports.toasts.some((t) => t.message.includes("Internal validation failed"))).toBe(false)
    expect(ports.toasts.some((t) => t.variant === "success" && t.message.includes("Distilled 3 messages"))).toBe(true)
    expect(ports.appendPlannedCalls).toBe(1)
    expect(ports.appendStatusCalls).toContain("done")
    // Los DELETEs apuntan a partes CURRENT (p-extra-a2), no a originales pristine (p-a1/p-a2/p-a3).
    const currentIDs = new Set(["prt_distill_OLD", "prt_stub_a2", "p-extra-a2", "prt_stub_a3"])
    expect(ports.deleteCalls.length).toBeGreaterThan(0)
    for (const call of ports.deleteCalls) {
      expect(currentIDs.has(call.partID)).toBe(true)
    }
    expect(ports.deleteCalls.some((c) => c.partID === "p-extra-a2")).toBe(true)
    expect(ports.deleteCalls.some((c) => c.partID === "p-a1" || c.partID === "p-a2" || c.partID === "p-a3")).toBe(false)
  })
})
