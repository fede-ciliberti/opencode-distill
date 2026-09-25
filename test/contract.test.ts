// Contract test de FlowPorts (task #12, Wave 2).
// Failing-first: importa de ../src/ports.js (regla dura).
// Define un fake api mínimo + un `adapt` de REFERENCIA en este archivo
// (los adaptadores reales api→ports viven en src/tui.ts, task #16) y
// verifica que satisface FlowPorts estructuralmente SIN casts, más smokes
// de runtime por puerto. Sin JSX, sin lógica de negocio.
//
// Convenciones: copy de UI en inglés, comentarios en español rioplatense.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendPlanned, appendStatus, latestTrace, readTraces } from "../src/journal.js"
import type {
  FlowPorts,
  PartWriteOutcome,
  SelectOption,
  ServerMessage,
  ToastVariant,
} from "../src/ports.js"
import type { MessageLike, PartLike, SessionStatusLike, TraceEntry } from "../src/pure.js"

// --- Fake api mínimo -------------------------------------------------------

/** Escritura programada: ok, fallo tipado, o throw crudo (el adapt lo colapsa). */
type ScriptedWrite =
  | { kind: "ok" }
  | { kind: "fail"; error: unknown; status?: number }
  | { kind: "throw"; error: unknown }

type FakeApi = {
  stateMessages: MessageLike[]
  serverNewestFirstBySession: Record<string, ServerMessage[]>
  partsByMessage: Map<string, PartLike[]>
  stateStatusBySession: Record<string, SessionStatusLike | undefined>
  serverStatus: Record<string, SessionStatusLike | undefined>
  updateScript: ScriptedWrite
  deleteScript: ScriptedWrite
  scratchSessions: Map<string, Array<{ directory: string; title: string; text: string }>>
  scratchSeq: number
  scratchReply: string
  directory: string
  confirms: Array<{ title: string; message: string }>
  confirmAuto: "confirm" | "cancel"
  prompts: Array<{ title: string; placeholder: string }>
  promptAuto: { kind: "value"; value: string } | { kind: "cancel" }
  selects: Array<{ title: string; count: number }>
  selectAuto: "first" | "cancel"
  toasts: Array<{ variant: ToastVariant; message: string }>
  routeName: string
  routeSessionID: string | undefined
  nowValue: number
}

function makeFake(directory: string): FakeApi {
  return {
    stateMessages: [],
    serverNewestFirstBySession: {},
    partsByMessage: new Map(),
    stateStatusBySession: {},
    serverStatus: {},
    updateScript: { kind: "ok" },
    deleteScript: { kind: "ok" },
    scratchSessions: new Map(),
    scratchSeq: 0,
    scratchReply: "distilled summary",
    directory,
    confirms: [],
    confirmAuto: "confirm",
    prompts: [],
    promptAuto: { kind: "value", value: "text reasoning" },
    selects: [],
    selectAuto: "first",
    toasts: [],
    routeName: "session",
    routeSessionID: "ses_1",
    nowValue: 1700000000000,
  }
}

function collapseScripted(script: ScriptedWrite): PartWriteOutcome {
  if (script.kind === "ok") return { ok: true }
  if (script.kind === "fail") return { ok: false, error: script.error, status: script.status }
  throw script.error
}

// Adaptador de REFERENCIA: fake api → FlowPorts. Los dos carriles del SDK
// (result.error vs throw) colapsan a PartWriteOutcome; jamás throwea crudo.
function adapt(fake: FakeApi): FlowPorts {
  return {
    listStateMessages(sessionID) {
      void sessionID
      // El store del TUI ya viene ascendente; el fake guarda una sola sesión.
      return fake.stateMessages
    },

    async fetchServerMessages(sessionID, limit) {
      // El server devuelve newest-first; el adaptador revierte a ascendente.
      const all = fake.serverNewestFirstBySession[sessionID] ?? []
      return [...all.slice(0, limit)].reverse()
    },

    readParts(messageID) {
      return fake.partsByMessage.get(messageID) ?? []
    },

    readStateStatus(sessionID) {
      return fake.stateStatusBySession[sessionID]
    },

    async fetchServerStatus() {
      return fake.serverStatus
    },

    async updatePart(args) {
      void args
      try {
        return collapseScripted(fake.updateScript)
      } catch (error: unknown) {
        return { ok: false, error }
      }
    },

    async deletePart(args) {
      void args
      try {
        return collapseScripted(fake.deleteScript)
      } catch (error: unknown) {
        return { ok: false, error }
      }
    },

    async createScratch(directory, title) {
      fake.scratchSeq += 1
      const sessionID = `ses_scratch_${fake.scratchSeq}`
      fake.scratchSessions.set(sessionID, [{ directory, title, text: "" }])
      return sessionID
    },

    async promptScratch(sessionID, directory, text) {
      const turns = fake.scratchSessions.get(sessionID)
      if (turns === undefined) throw new Error(`Scratch session not found: ${sessionID}`)
      turns.push({ directory, title: "", text })
      return { text: fake.scratchReply, model: { providerID: "anthropic", modelID: "claude-sonnet-4" } }
    },

    async deleteScratch(sessionID, directory) {
      void directory
      fake.scratchSessions.delete(sessionID)
    },

    appendPlanned(entry, ts) {
      return appendPlanned(fake.directory, entry, ts)
    },

    appendStatus(sessionID, ts, status, at) {
      return appendStatus(fake.directory, sessionID, ts, status, at)
    },

    readTraces(sessionID) {
      return readTraces(fake.directory, sessionID)
    },

    latestTrace(sessionID) {
      return latestTrace(fake.directory, sessionID)
    },

    confirmDialog(title, message, onConfirm, onCancel) {
      fake.confirms.push({ title, message })
      if (fake.confirmAuto === "confirm") onConfirm()
      else onCancel()
    },

    promptDialog(title, placeholder, onValue, onCancel) {
      fake.prompts.push({ title, placeholder })
      const auto = fake.promptAuto
      if (auto.kind === "value") onValue(auto.value)
      else onCancel()
    },

    selectDialog<T>(
      title: string,
      options: readonly SelectOption<T>[],
      current: T | undefined,
      onSelect: (value: T) => void,
      onCancel: () => void,
    ) {
      void current
      fake.selects.push({ title, count: options.length })
      const first = options[0]
      if (fake.selectAuto === "first" && first !== undefined) onSelect(first.value)
      else onCancel()
    },

    toast(variant, message) {
      fake.toasts.push({ variant, message })
    },

    currentRouteName() {
      return fake.routeName
    },

    currentSessionID() {
      return fake.routeSessionID
    },

    readDirectory() {
      return fake.directory
    },

    now() {
      return fake.nowValue
    },
  }
}

// --- Fixtures ---------------------------------------------------------------

function textPart(messageID: string, id: string, text: string): PartLike {
  return { id, sessionID: "ses_1", messageID, type: "text", text }
}

function assistantMessage(id: string, created: number, parts: readonly PartLike[]): MessageLike {
  return { id, role: "assistant", time: { created }, parts }
}

function plannedEntry(sessionID: string): TraceEntry {
  return {
    version: 1,
    sessionID,
    createdAt: 1700000000000,
    stretch: ["m1", "m2"],
    originals: [],
    createdPartIDs: [],
    plan: [],
    distillate: {
      summary: "summary",
      stubs: {},
      model: { providerID: "p", modelID: "m" },
    },
    status: "planned",
  }
}

let scratchDirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "contract-"))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  scratchDirs = []
})

// --- Contract ----------------------------------------------------------------

describe("FlowPorts contract (adapt de referencia, sin casts)", () => {
  test("el adapt satisface FlowPorts estructuralmente", () => {
    const ports: FlowPorts = adapt(makeFake(freshDir()))
    expect(typeof ports.listStateMessages).toBe("function")
    expect(typeof ports.fetchServerMessages).toBe("function")
    expect(typeof ports.readParts).toBe("function")
    expect(typeof ports.readStateStatus).toBe("function")
    expect(typeof ports.fetchServerStatus).toBe("function")
    expect(typeof ports.updatePart).toBe("function")
    expect(typeof ports.deletePart).toBe("function")
    expect(typeof ports.createScratch).toBe("function")
    expect(typeof ports.promptScratch).toBe("function")
    expect(typeof ports.deleteScratch).toBe("function")
    expect(typeof ports.appendPlanned).toBe("function")
    expect(typeof ports.appendStatus).toBe("function")
    expect(typeof ports.readTraces).toBe("function")
    expect(typeof ports.latestTrace).toBe("function")
    expect(typeof ports.confirmDialog).toBe("function")
    expect(typeof ports.promptDialog).toBe("function")
    expect(typeof ports.selectDialog).toBe("function")
    expect(typeof ports.toast).toBe("function")
    expect(typeof ports.currentRouteName).toBe("function")
    expect(typeof ports.currentSessionID).toBe("function")
    expect(typeof ports.readDirectory).toBe("function")
    expect(typeof ports.now).toBe("function")
  })

  test("MessageSource: state asc, server newest-first→reverse con limit, readParts", async () => {
    const fake = makeFake(freshDir())
    const m1 = assistantMessage("m1", 100, [textPart("m1", "p1", "aaa")])
    const m2 = assistantMessage("m2", 200, [textPart("m2", "p2", "bbb")])
    fake.stateMessages = [m1, m2]
    fake.serverNewestFirstBySession = {
      ses_1: [
        { info: m2, parts: m2.parts },
        { info: m1, parts: m1.parts },
      ],
    }
    fake.partsByMessage.set("m1", [textPart("m1", "p1", "aaa")])
    const ports: FlowPorts = adapt(fake)

    expect(ports.listStateMessages("ses_1").map((m) => m.id)).toEqual(["m1", "m2"])
    const fetched = await ports.fetchServerMessages("ses_1", 10)
    expect(fetched.map((m) => m.info.id)).toEqual(["m1", "m2"])
    expect(fetched[0]?.parts.map((p) => p.id)).toEqual(["p1"])
    const limited = await ports.fetchServerMessages("ses_1", 1)
    expect(limited.map((m) => m.info.id)).toEqual(["m2"])
    expect(ports.readParts("m1").map((p) => p.id)).toEqual(["p1"])
    expect(ports.readParts("missing")).toEqual([])
  })

  test("StatusSource: undefined en bootstrap, busy del state, mapa del server", async () => {
    const fake = makeFake(freshDir())
    fake.stateStatusBySession = { ses_1: { type: "busy" } }
    fake.serverStatus = { ses_1: { type: "busy" } }
    const ports: FlowPorts = adapt(fake)

    expect(ports.readStateStatus("ses_bootstrap")).toBeUndefined()
    expect(ports.readStateStatus("ses_1")).toEqual({ type: "busy" })
    const map = await ports.fetchServerStatus()
    expect(map["ses_1"]).toEqual({ type: "busy" })
    expect(map["ses_missing"]).toBeUndefined()
  })

  test("PartWriter: ok, fallo tipado con status, throw colapsado sin throw crudo", async () => {
    const fake = makeFake(freshDir())
    const ports: FlowPorts = adapt(fake)
    const args = { sessionID: "ses_1", messageID: "m1", partID: "p1", directory: fake.directory }

    expect(await ports.updatePart({ ...args, part: textPart("m1", "p1", "x") })).toEqual({ ok: true })
    expect(await ports.deletePart(args)).toEqual({ ok: true })

    const boom = new Error("boom")
    fake.updateScript = { kind: "fail", error: boom, status: 404 }
    expect(await ports.updatePart({ ...args, part: textPart("m1", "p1", "x") })).toEqual({
      ok: false,
      error: boom,
      status: 404,
    })

    fake.deleteScript = { kind: "throw", error: boom }
    await expect(ports.deletePart(args)).resolves.toEqual({ ok: false, error: boom })
  })

  test("ScratchSession: create→prompt→delete con reply de texto + modelo", async () => {
    const fake = makeFake(freshDir())
    const ports: FlowPorts = adapt(fake)

    const sessionID = await ports.createScratch(fake.directory, "distill-scratch")
    expect(typeof sessionID).toBe("string")
    expect(sessionID.length).toBeGreaterThan(0)
    const reply = await ports.promptScratch(sessionID, fake.directory, "distill this")
    expect(reply.text).toBe("distilled summary")
    expect(reply.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    await ports.deleteScratch(sessionID, fake.directory)
    expect(fake.scratchSessions.has(sessionID)).toBe(false)
    await expect(ports.promptScratch(sessionID, fake.directory, "late")).rejects.toThrow()
  })

  test("JournalPort: bindea journal.ts con directory (planned→executing→done)", () => {
    const fake = makeFake(freshDir())
    const ports: FlowPorts = adapt(fake)
    const ts = 1700000000000

    const planned = ports.appendPlanned(plannedEntry("ses_1"), ts)
    expect(planned.ok).toBe(true)
    const traces = ports.readTraces("ses_1")
    expect(traces.ok).toBe(true)
    if (!traces.ok) return
    expect(traces.traces).toHaveLength(1)
    const latest = ports.latestTrace("ses_1")
    expect(latest.ok).toBe(true)
    if (!latest.ok) return
    expect(latest.trace?.status).toBe("planned")
    expect(ports.appendStatus("ses_1", ts, "done", ts + 1).ok).toBe(true)
    const latest2 = ports.latestTrace("ses_1")
    expect(latest2.ok).toBe(true)
    if (!latest2.ok) return
    expect(latest2.trace?.status).toBe("done")
  })

  test("Confirmer/Prompter/Selector/Toaster: registran y disparan callbacks", () => {
    const fake = makeFake(freshDir())
    const ports: FlowPorts = adapt(fake)

    let confirmed = 0
    let cancelled = 0
    ports.confirmDialog("Distill?", "Sure?", () => (confirmed += 1), () => (cancelled += 1))
    expect({ confirmed, cancelled }).toEqual({ confirmed: 1, cancelled: 0 })
    expect(fake.confirms).toEqual([{ title: "Distill?", message: "Sure?" }])
    fake.confirmAuto = "cancel"
    ports.confirmDialog("T", "M", () => (confirmed += 1), () => (cancelled += 1))
    expect({ confirmed, cancelled }).toEqual({ confirmed: 1, cancelled: 1 })

    let gotValue = ""
    ports.promptDialog("Content types", "e.g. text reasoning tool", (v) => (gotValue = v), () => {})
    expect(gotValue).toBe("text reasoning")
    expect(fake.prompts).toEqual([{ title: "Content types", placeholder: "e.g. text reasoning tool" }])

    type Spec = { kind: string }
    const options: readonly SelectOption<Spec>[] = [
      { title: "Current turn", value: { kind: "current-turn" } },
      { title: "Last 3", value: { kind: "last-n" }, description: "3 messages" },
    ]
    let picked: Spec | undefined
    let selectCancelled = 0
    ports.selectDialog("Pick stretch", options, undefined, (v) => (picked = v), () => (selectCancelled += 1))
    expect(picked).toEqual({ kind: "current-turn" })
    expect(fake.selects).toEqual([{ title: "Pick stretch", count: 2 }])
    fake.selectAuto = "cancel"
    ports.selectDialog("Pick", options, options[1]?.value, (v) => (picked = v), () => (selectCancelled += 1))
    expect(selectCancelled).toBe(1)

    const variants: ToastVariant[] = ["info", "success", "warning", "error"]
    for (const variant of variants) ports.toast(variant, `${variant} msg`)
    expect(fake.toasts).toEqual(variants.map((variant) => ({ variant, message: `${variant} msg` })))
  })

  test("RouteReader/DirectoryReader/Clock: ruta, directorio y reloj", () => {
    const fake = makeFake(freshDir())
    const ports: FlowPorts = adapt(fake)

    expect(ports.currentRouteName()).toBe("session")
    expect(ports.currentSessionID()).toBe("ses_1")
    expect(ports.readDirectory()).toBe(fake.directory)
    expect(ports.now()).toBe(1700000000000)
    fake.routeName = "home"
    fake.routeSessionID = undefined
    expect(ports.currentRouteName()).toBe("home")
    expect(ports.currentSessionID()).toBeUndefined()
  })

  test("ports.ts no necesita el SDK en runtime (solo tipos de pure/journal)", () => {
    const source = readFileSync(new URL("../src/ports.ts", import.meta.url), "utf8")
    expect(source).not.toContain("@opencode-ai/sdk")
    expect(source).not.toContain("@opencode-ai/plugin")
    expect(source).not.toContain("createOpencodeClient")
  })
})
