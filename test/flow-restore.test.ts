// Failing-first para runRestoreFlow (task #15, Wave 2 TDD con fakes).
// Importa de ../src/flow.js y ../src/pure.js (regla dura).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetDistillMutexForTests, runRestoreFlow } from "../src/flow.js"
import type {
  AppendPlannedResult,
  AppendStatusResult,
  LatestTraceResult,
  ReadTrace,
  ReadTracesResult,
} from "../src/journal.js"
import type {
  DeletePartArgs,
  FlowPorts,
  PartWriteOutcome,
  SelectOption,
  ServerMessage,
  SessionStatusLike,
  ToastVariant,
  UpdatePartArgs,
} from "../src/ports.js"
import { buildRestoreConfirmMessage } from "../src/pure.js"
import type { MessageLike, PartLike, TraceEntry } from "../src/pure.js"

const SESSION = "s1"
const DIR = "/tmp/flow-restore-test"

const T1_TS = Date.UTC(2024, 4, 6, 7, 8, 0)
const T2_TS = Date.UTC(2024, 4, 7, 9, 10, 0)

function textPart(id: string, messageID: string, text: string): PartLike {
  return { id, sessionID: SESSION, messageID, type: "text", text }
}

function makeEntry(
  ts: number,
  stretch: readonly string[],
  originals: ReadonlyArray<{ messageID: string; part: PartLike }>,
  createdPartIDs: readonly string[],
  status: TraceEntry["status"],
): TraceEntry {
  return {
    version: 1,
    sessionID: SESSION,
    createdAt: ts,
    stretch: [...stretch],
    originals: originals.map((o) => ({ messageID: o.messageID, part: { ...o.part } })),
    createdPartIDs: [...createdPartIDs],
    plan: [],
    distillate: { summary: "summary", stubs: {}, model: { providerID: "test", modelID: "test-model" } },
    status,
  }
}

function healthyTrace(ts: number, entry: TraceEntry, status: TraceEntry["status"]): ReadTrace {
  return { ok: true, ts, file: `${DIR}/.opencode/distill/${SESSION}/${ts}.jsonl`, entry, status }
}

function corruptTrace(file: string): ReadTrace {
  return { ok: false, reason: "corrupt", file, message: `Invalid entry in ${file}` }
}

type WriteScript = Array<{ ok: true } | { ok: false; error: unknown; status?: number }>

class FakePorts implements FlowPorts {
  routeName = "session"
  sessionIDValue: string | undefined = SESSION
  directoryValue = DIR
  nowValue = 1710000000000
  stateStatusValue: SessionStatusLike | undefined = { type: "idle" }
  serverStatusMapValue: Readonly<Record<string, SessionStatusLike | undefined>> = {}
  partsByMessageValue = new Map<string, readonly PartLike[]>()
  readTracesQueue: ReadTracesResult[] = []
  readTracesDefault: ReadTrace[] = []

  calls: string[] = []
  toasts: Array<{ variant: string; message: string }> = []
  selectCalls: Array<{
    title: string
    options: Array<{ title: string; description?: string; value: unknown }>
    current: unknown
  }> = []
  confirmCalls: Array<{ title: string; message: string }> = []
  updateCalls: Array<{ partID: string; messageID: string }> = []
  deleteCalls: Array<{ partID: string; messageID: string }> = []
  appendStatusCalls: Array<{ ts: number; status: string }> = []

  selectAuto: Array<number | "cancel"> = []
  selectIndex = 0
  confirmAuto: Array<"confirm" | "cancel"> = []
  confirmIndex = 0
  updateScript: WriteScript = []
  deleteScript: WriteScript = []

  listStateMessages(_sessionID: string): readonly MessageLike[] {
    this.calls.push("listStateMessages")
    return []
  }
  async fetchServerMessages(_sessionID: string, _limit: number): Promise<readonly ServerMessage[]> {
    this.calls.push("fetchServerMessages")
    return []
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
    return this.serverStatusMapValue
  }
  async updatePart(args: UpdatePartArgs): Promise<PartWriteOutcome> {
    this.calls.push(`updatePart:${args.partID}`)
    this.updateCalls.push({ partID: args.partID, messageID: args.messageID })
    const script = this.updateScript.shift()
    if (script !== undefined && !script.ok) return { ok: false, error: script.error, status: script.status }
    return { ok: true }
  }
  async deletePart(args: DeletePartArgs): Promise<PartWriteOutcome> {
    this.calls.push(`deletePart:${args.partID}`)
    this.deleteCalls.push({ partID: args.partID, messageID: args.messageID })
    const script = this.deleteScript.shift()
    if (script !== undefined && !script.ok) return { ok: false, error: script.error, status: script.status }
    return { ok: true }
  }
  async createScratch(_directory: string, _title: string): Promise<string> {
    this.calls.push("createScratch")
    return "scratch-1"
  }
  async promptScratch(
    _sessionID: string,
    _directory: string,
    _text: string,
  ): Promise<{ text: string; model: { providerID: string; modelID: string } }> {
    this.calls.push("promptScratch")
    return { text: "", model: { providerID: "test", modelID: "test-model" } }
  }
  async deleteScratch(_sessionID: string, _directory: string): Promise<void> {
    this.calls.push("deleteScratch")
  }
  appendPlanned(_entry: TraceEntry, _ts: number): AppendPlannedResult {
    this.calls.push("appendPlanned")
    return { ok: true, file: "fake", ts: 0 }
  }
  appendStatus(sessionID: string, ts: number, status: string, _at: number): AppendStatusResult {
    this.calls.push(`appendStatus:${status}`)
    this.appendStatusCalls.push({ ts, status })
    void sessionID
    return { ok: true, file: "fake" }
  }
  readTraces(_sessionID: string): ReadTracesResult {
    this.calls.push("readTraces")
    const next = this.readTracesQueue.shift()
    if (next !== undefined) return next
    return { ok: true, traces: this.readTracesDefault }
  }
  latestTrace(_sessionID: string): LatestTraceResult {
    return { ok: true, trace: undefined }
  }
  confirmDialog(title: string, message: string, onConfirm: () => void, onCancel: () => void): void {
    this.calls.push(`confirmDialog:${title}`)
    this.confirmCalls.push({ title, message })
    const auto = this.confirmAuto[this.confirmIndex++] ?? "confirm"
    if (auto === "confirm") onConfirm()
    else onCancel()
  }
  promptDialog(
    title: string,
    placeholder: string,
    _onValue: (value: string) => void,
    onCancel: () => void,
  ): void {
    this.calls.push(`promptDialog:${title}`)
    void placeholder
    onCancel()
  }
  selectDialog<T>(
    title: string,
    options: readonly SelectOption<T>[],
    current: T | undefined,
    onSelect: (value: T) => void,
    onCancel: () => void,
  ): void {
    this.calls.push(`selectDialog:${title}`)
    this.selectCalls.push({
      title,
      options: options.map((o) => ({ title: o.title, description: o.description, value: o.value })),
      current,
    })
    const auto = this.selectAuto[this.selectIndex++]
    if (auto === "cancel") {
      onCancel()
      return
    }
    const idx = typeof auto === "number" ? auto : 0
    const opt = options[idx]
    if (opt !== undefined) onSelect(opt.value)
    else onCancel()
  }
  toast(variant: ToastVariant, message: string): void {
    this.calls.push(`toast:${variant}`)
    this.toasts.push({ variant, message })
  }
  currentRouteName(): string {
    return this.routeName
  }
  currentSessionID(): string | undefined {
    return this.sessionIDValue
  }
  readDirectory(): string {
    return this.directoryValue
  }
  now(): number {
    return this.nowValue
  }
}

/** Dos trazas sanas disjuntas: T1 vieja (stretch a1), T2 nueva (stretch a2). */
function setupTwoTraces(): { ports: FakePorts; t1: ReadTrace; t2: ReadTrace } {
  const ports = new FakePorts()
  const t1Entry = makeEntry(
    T1_TS,
    ["a1"],
    [{ messageID: "a1", part: textPart("p-a1", "a1", "original a1") }],
    ["prt_distill_old"],
    "done",
  )
  const t2Entry = makeEntry(
    T2_TS,
    ["a2"],
    [{ messageID: "a2", part: textPart("p-a2", "a2", "original a2") }],
    ["prt_distill_new"],
    "done",
  )
  const t1 = healthyTrace(T1_TS, t1Entry, "done")
  const t2 = healthyTrace(T2_TS, t2Entry, "done")
  ports.readTracesDefault = [t2, t1]
  ports.partsByMessageValue.set("a1", [
    { ...textPart("prt_distill_old", "a1", "distilled old"), synthetic: true },
  ])
  ports.partsByMessageValue.set("a2", [
    { ...textPart("prt_distill_new", "a2", "distilled new"), synthetic: true },
  ])
  return { ports, t1, t2 }
}

beforeEach(() => {
  __resetDistillMutexForTests()
})
afterEach(() => {
  __resetDistillMutexForTests()
})

async function flush(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0))
  await new Promise<void>((r) => setTimeout(r, 0))
  await new Promise<void>((r) => setTimeout(r, 50))
}

describe("runRestoreFlow", () => {
  test("happy path restores latest by default", async () => {
    const { ports } = setupTwoTraces()
    ports.selectAuto = [0]
    runRestoreFlow(ports)
    await flush()
    expect(
      ports.toasts.some(
        (t) => t.variant === "success" && t.message === "Restore complete — original content is back",
      ),
    ).toBe(true)
    expect(ports.updateCalls).toEqual([{ partID: "p-a2", messageID: "a2" }])
    expect(ports.deleteCalls).toEqual([{ partID: "prt_distill_new", messageID: "a2" }])
    const updateIdx = ports.calls.findIndex((c) => c.startsWith("updatePart"))
    const deleteIdx = ports.calls.findIndex((c) => c.startsWith("deletePart"))
    expect(updateIdx).toBeGreaterThanOrEqual(0)
    expect(deleteIdx).toBeGreaterThanOrEqual(0)
    expect(updateIdx).toBeLessThan(deleteIdx)
    expect(ports.appendStatusCalls).toEqual([{ ts: T2_TS, status: "restored" }])
    expect(ports.selectCalls[0]?.current).toBe(T2_TS)
  })

  test("specific selection restores the chosen older trace", async () => {
    const { ports } = setupTwoTraces()
    ports.selectAuto = [1]
    runRestoreFlow(ports)
    await flush()
    expect(ports.updateCalls).toEqual([{ partID: "p-a1", messageID: "a1" }])
    expect(ports.deleteCalls).toEqual([{ partID: "prt_distill_old", messageID: "a1" }])
    expect(ports.appendStatusCalls).toEqual([{ ts: T1_TS, status: "restored" }])
    expect(
      ports.toasts.some((t) => t.variant === "success" && t.message.includes("Restore complete")),
    ).toBe(true)
  })

  test("select options desc by date with formatted titles, stretch descriptions, current=latest", async () => {
    const { ports, t2 } = setupTwoTraces()
    ports.selectAuto = [0]
    runRestoreFlow(ports)
    await flush()
    const call = ports.selectCalls[0]
    expect(call?.title.toLowerCase()).toContain("restore")
    const options = call?.options ?? []
    expect(options.length).toBe(2)
    expect(options[0]?.value).toBe(T2_TS)
    expect(options[1]?.value).toBe(T1_TS)
    expect(options[0]?.title).toBe("2024-05-07 09:10 — 1 messages (done)")
    expect(options[1]?.title).toBe("2024-05-06 07:08 — 1 messages (done)")
    expect(options[0]?.description).toBe("a2")
    expect(options[1]?.description).toBe("a1")
    expect(call?.current).toBe(T2_TS)
    if (t2.ok) {
      expect(ports.confirmCalls[0]?.message).toBe(
        buildRestoreConfirmMessage({ createdAt: t2.entry.createdAt, stretch: t2.entry.stretch }),
      )
    } else {
      throw new Error("t2 must be healthy in this setup")
    }
  })

  test("corrupt trace listed as (corrupt) and not selectable", async () => {
    const { ports, t1, t2 } = setupTwoTraces()
    const bad = corruptTrace(`${DIR}/.opencode/distill/${SESSION}/bad.jsonl`)
    ports.readTracesDefault = [t2, bad, t1]
    ports.selectAuto = [1]
    runRestoreFlow(ports)
    await flush()
    const options = ports.selectCalls[0]?.options ?? []
    expect(options.length).toBe(3)
    expect(options[1]?.title).toContain("(corrupt)")
    const values = options.map((o) => o.value)
    expect(values).toContain(T2_TS)
    expect(values).toContain(T1_TS)
    expect(ports.updateCalls).toHaveLength(0)
    expect(ports.deleteCalls).toHaveLength(0)
    expect(ports.appendStatusCalls).toHaveLength(0)
    expect(
      ports.toasts.some((t) => t.variant === "warning" && t.message.includes("Trace not found")),
    ).toBe(true)
  })

  test("all corrupt → refuse without opening select", async () => {
    const ports = new FakePorts()
    ports.readTracesDefault = [corruptTrace("a.jsonl"), corruptTrace("b.jsonl")]
    runRestoreFlow(ports)
    await flush()
    expect(
      ports.toasts.some(
        (t) =>
          t.variant === "warning" &&
          t.message === "All distill traces are corrupted — restore unavailable",
      ),
    ).toBe(true)
    expect(ports.selectCalls).toHaveLength(0)
    expect(ports.updateCalls).toHaveLength(0)
    expect(ports.deleteCalls).toHaveLength(0)
  })

  test("clean trace with corrupt intersecting trace → refuse, zero writes", async () => {
    const { ports } = setupTwoTraces()
    ports.readTracesDefault = [...ports.readTracesDefault, corruptTrace("c.jsonl")]
    ports.selectAuto = [0]
    runRestoreFlow(ports)
    await flush()
    expect(
      ports.toasts.some(
        (t) =>
          t.variant === "warning" &&
          t.message === "A related distill trace is corrupted — restore unavailable for this stretch",
      ),
    ).toBe(true)
    expect(ports.updateCalls).toHaveLength(0)
    expect(ports.deleteCalls).toHaveLength(0)
    expect(ports.appendStatusCalls).toHaveLength(0)
  })

  test("busy at gate → warn and return", async () => {
    const { ports } = setupTwoTraces()
    ports.stateStatusValue = { type: "busy" }
    runRestoreFlow(ports)
    await flush()
    expect(
      ports.toasts.some(
        (t) => t.variant === "warning" && t.message === "Session is busy — try again when it's idle",
      ),
    ).toBe(true)
    expect(ports.selectCalls).toHaveLength(0)
    expect(ports.calls).not.toContain("readTraces")
    expect(ports.updateCalls).toHaveLength(0)
  })

  test("busy at re-check aborts before any write", async () => {
    const { ports } = setupTwoTraces()
    ports.selectAuto = [0]
    const origConfirm = ports.confirmDialog.bind(ports)
    ports.confirmDialog = (title, message, onConfirm, onCancel): void => {
      ports.stateStatusValue = { type: "busy" }
      origConfirm(title, message, onConfirm, onCancel)
    }
    runRestoreFlow(ports)
    await flush()
    expect(ports.toasts.some((t) => t.message === "Session is busy — try again when it's idle")).toBe(
      true,
    )
    expect(ports.updateCalls).toHaveLength(0)
    expect(ports.deleteCalls).toHaveLength(0)
    expect(ports.appendStatusCalls).toHaveLength(0)
  })

  test("trace disappeared before re-valid → not found, zero writes", async () => {
    const { ports, t1, t2 } = setupTwoTraces()
    ports.readTracesQueue = [{ ok: true, traces: [t2, t1] }, { ok: true, traces: [t1] }]
    ports.selectAuto = [0]
    runRestoreFlow(ports)
    await flush()
    expect(
      ports.toasts.some(
        (t) => t.variant === "warning" && t.message === "Trace not found — nothing restored",
      ),
    ).toBe(true)
    expect(ports.updateCalls).toHaveLength(0)
    expect(ports.deleteCalls).toHaveLength(0)
    expect(ports.appendStatusCalls).toHaveLength(0)
  })

  test("mid-batch failure → retry-safe error, deletes skipped, no restored mark", async () => {
    const ports = new FakePorts()
    const entry = makeEntry(
      T2_TS,
      ["a1", "a2"],
      [
        { messageID: "a1", part: textPart("p-a1", "a1", "original a1") },
        { messageID: "a2", part: textPart("p-a2", "a2", "original a2") },
      ],
      ["prt_distill_x"],
      "done",
    )
    ports.readTracesDefault = [healthyTrace(T2_TS, entry, "done")]
    ports.partsByMessageValue.set("a1", [textPart("prt_distill_x", "a1", "distilled")])
    ports.partsByMessageValue.set("a2", [])
    ports.selectAuto = [0]
    ports.updateScript = [
      { ok: true },
      { ok: false, error: { name: "NotFoundError", data: { message: "gone" } }, status: 404 },
    ]
    runRestoreFlow(ports)
    await flush()
    expect(ports.updateCalls.length).toBe(2)
    expect(ports.deleteCalls).toHaveLength(0)
    expect(
      ports.toasts.some(
        (t) =>
          t.variant === "error" &&
          t.message.includes("Restore incomplete") &&
          t.message.includes("safe to retry"),
      ),
    ).toBe(true)
    expect(ports.appendStatusCalls).toHaveLength(0)
  })

  test("cancel at confirm → silent return, zero writes", async () => {
    const { ports } = setupTwoTraces()
    ports.selectAuto = [0]
    ports.confirmAuto = ["cancel"]
    runRestoreFlow(ports)
    await flush()
    expect(ports.updateCalls).toHaveLength(0)
    expect(ports.deleteCalls).toHaveLength(0)
    expect(ports.appendStatusCalls).toHaveLength(0)
    expect(ports.toasts).toHaveLength(0)
  })

  test("cancel at select → silent return", async () => {
    const { ports } = setupTwoTraces()
    ports.selectAuto = ["cancel"]
    runRestoreFlow(ports)
    await flush()
    expect(ports.toasts).toHaveLength(0)
    expect(ports.updateCalls).toHaveLength(0)
    expect(ports.confirmCalls).toHaveLength(0)
  })

  test("route not session → info toast, zero writes", async () => {
    const { ports } = setupTwoTraces()
    ports.routeName = "home"
    runRestoreFlow(ports)
    await flush()
    expect(
      ports.toasts.some((t) => t.variant === "info" && t.message.includes("Open a session")),
    ).toBe(true)
    expect(ports.selectCalls).toHaveLength(0)
    expect(ports.updateCalls).toHaveLength(0)
  })

  test("no traces → info toast", async () => {
    const ports = new FakePorts()
    ports.readTracesDefault = []
    runRestoreFlow(ports)
    await flush()
    expect(
      ports.toasts.some(
        (t) => t.variant === "info" && t.message === "No distill traces for this session",
      ),
    ).toBe(true)
    expect(ports.selectCalls).toHaveLength(0)
  })
})
