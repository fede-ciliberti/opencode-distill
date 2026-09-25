// Cadena completa DEC-4: pristineReconstruct + buildRestoreOps (task #11).
// Failing-first: importan de ../src/journal.js y ../src/pure.js (regla dura).
// FS REAL para el load (mkdtempSync + appendPlanned + readTraces); inversión pura in-memory.
import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendPlanned,
  appendStatus,
  buildRestoreOps,
  intersectingTraces,
  pristineReconstruct,
  readTraces,
  traceFilePath,
  type ReadTrace,
  type TraceEntry,
} from "../src/journal.js"
import type { PartLike } from "../src/pure.js"

const SES = "ses-chain"

let scratch: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chain-"))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true })
  }
  scratch = []
})

function textPart(messageID: string, id: string, text: string): PartLike {
  return { id, sessionID: SES, messageID, type: "text", text }
}

function reasoningPart(messageID: string, id: string, text: string): PartLike {
  return { id, sessionID: SES, messageID, type: "reasoning", text }
}

// Contenido prístino (pre-cualquier-distill).
const PRISTINE_A1 = textPart("msg-a", "prt-a1", "original alfa: la derivación completa del cálculo")
const PRISTINE_B1 = reasoningPart("msg-b", "prt-b1", "original beta: cadena de pensamiento")

function makeEntry(
  stretch: readonly string[],
  originals: ReadonlyArray<{ messageID: string; part: PartLike }>,
  createdPartIDs: readonly string[],
): TraceEntry {
  return {
    version: 1,
    sessionID: SES,
    createdAt: 1700000000000,
    stretch,
    originals,
    createdPartIDs,
    plan: [],
    distillate: { summary: "resumen", stubs: {}, model: { providerID: "p", modelID: "m" } },
    status: "planned",
  }
}

// T1 destila [msg-a, msg-b]; T2 re-destila [msg-b] sobre el stub de T1.
const T1 = makeEntry(
  ["msg-a", "msg-b"],
  [
    { messageID: "msg-a", part: PRISTINE_A1 },
    { messageID: "msg-b", part: PRISTINE_B1 },
  ],
  ["prt-d1"],
)
const STUB_B1 = reasoningPart("msg-b", "prt-b1", "STUB beta")
const T2 = makeEntry(["msg-b"], [{ messageID: "msg-b", part: STUB_B1 }], ["prt-d2"])

// Estado actual tras T1+T2: stubs + partes sintéticas huérfanas.
function currentAfterT1T2(): ReadonlyMap<string, readonly PartLike[]> {
  return new Map([
    [
      "msg-a",
      [textPart("msg-a", "prt-a1", "STUB alfa"), textPart("msg-a", "prt-d1", "destilado T1")],
    ],
    [
      "msg-b",
      [
        reasoningPart("msg-b", "prt-b1", "DESTILADO T2 beta"),
        textPart("msg-b", "prt-d2", "destilado T2"),
      ],
    ],
  ])
}

// Load real: escribe T1(ts 1000)+T2(ts 2000) y lee con readTraces (desc: newest primero).
function loadTraces(dir: string): ReadonlyArray<ReadTrace> {
  const r1 = appendPlanned(dir, T1, 1000)
  if (!r1.ok) throw new Error(`appendPlanned T1 failed: ${r1.message}`)
  const r2 = appendPlanned(dir, T2, 2000)
  if (!r2.ok) throw new Error(`appendPlanned T2 failed: ${r2.message}`)
  const loaded = readTraces(dir, SES)
  if (!loaded.ok) throw new Error(`readTraces failed: ${loaded.message}`)
  return loaded.traces
}

describe("intersectingTraces", () => {
  test("filtra por intersección de stretch (T1∩[msg-a], T2∩[msg-a]=∅)", () => {
    const traces = loadTraces(freshDir())
    const hit = intersectingTraces(traces, ["msg-a"])
    expect(hit.length).toBe(1)
    if (!hit[0]?.ok) throw new Error("expected healthy trace")
    expect(hit[0].entry.stretch).toEqual(["msg-a", "msg-b"])
    expect(intersectingTraces(traces, ["msg-zzz"])).toEqual([])
    expect(intersectingTraces(traces, ["msg-b"]).length).toBe(2)
  })
})

describe("pristineReconstruct", () => {
  test("sin trazas → pristine == current", () => {
    const current = currentAfterT1T2()
    const res = pristineReconstruct(current, [], ["msg-a", "msg-b"])
    if (!res.ok) throw new Error("expected ok")
    expect(res.pristine.get("msg-a")).toEqual(current.get("msg-a"))
    expect(res.pristine.get("msg-b")).toEqual(current.get("msg-b"))
  })

  test("2 trazas solapadas → pristine verdadero (gana el original más viejo)", () => {
    const traces = loadTraces(freshDir())
    const res = pristineReconstruct(currentAfterT1T2(), traces, ["msg-a", "msg-b"])
    if (!res.ok) throw new Error("expected ok")
    expect(res.pristine.get("msg-a")).toEqual([PRISTINE_A1])
    expect(res.pristine.get("msg-b")).toEqual([PRISTINE_B1])
  })

  test("ordena internamente NEWEST→OLDEST aunque entren oldest-first", () => {
    const traces = loadTraces(freshDir())
    const ascending = [...traces].reverse()
    if (!ascending[0]?.ok || !ascending[1]?.ok) throw new Error("expected 2 healthy traces")
    expect(ascending[0].ts).toBeLessThan(ascending[1].ts)
    const res = pristineReconstruct(currentAfterT1T2(), ascending, ["msg-a", "msg-b"])
    if (!res.ok) throw new Error("expected ok")
    expect(res.pristine.get("msg-a")).toEqual([PRISTINE_A1])
    expect(res.pristine.get("msg-b")).toEqual([PRISTINE_B1])
    expect(traces[0]?.ok && traces[0].ts).toBe(2000)
  })

  test("remueve createdPartIDs (destilados sintéticos fuera del pristine)", () => {
    const traces = loadTraces(freshDir())
    const res = pristineReconstruct(currentAfterT1T2(), traces, ["msg-a", "msg-b"])
    if (!res.ok) throw new Error("expected ok")
    const idsA = (res.pristine.get("msg-a") ?? []).map((p) => p.id)
    const idsB = (res.pristine.get("msg-b") ?? []).map((p) => p.id)
    expect(idsA).not.toContain("prt-d1")
    expect(idsB).not.toContain("prt-d2")
  })

  test("re-restore es idempotente (invertir lo ya invertido = no-op)", () => {
    const traces = loadTraces(freshDir())
    const first = pristineReconstruct(currentAfterT1T2(), traces, ["msg-a", "msg-b"])
    if (!first.ok) throw new Error("expected ok first")
    const second = pristineReconstruct(first.pristine, traces, ["msg-a", "msg-b"])
    if (!second.ok) throw new Error("expected ok second")
    expect(second.pristine.get("msg-a")).toEqual(first.pristine.get("msg-a"))
    expect(second.pristine.get("msg-b")).toEqual(first.pristine.get("msg-b"))
  })

  test("status-independiente (trazas done igual invierten)", () => {
    const dir = freshDir()
    const traces = loadTraces(dir)
    const done = appendStatus(dir, SES, 1000, "done", 1700000000001)
    if (!done.ok) throw new Error(`appendStatus failed: ${done.message}`)
    const reloaded = readTraces(dir, SES)
    if (!reloaded.ok) throw new Error(`readTraces failed: ${reloaded.message}`)
    expect(traces.length).toBe(reloaded.traces.length)
    const res = pristineReconstruct(currentAfterT1T2(), reloaded.traces, ["msg-a", "msg-b"])
    if (!res.ok) throw new Error("expected ok")
    expect(res.pristine.get("msg-a")).toEqual([PRISTINE_A1])
    expect(res.pristine.get("msg-b")).toEqual([PRISTINE_B1])
  })

  test("traza corrupta intersectante → refuse corrupt-trace", () => {
    const dir = freshDir()
    loadTraces(dir)
    appendFileSync(traceFilePath(dir, SES, 1500), '{"truncated": ', "utf8")
    const loaded = readTraces(dir, SES)
    if (!loaded.ok) throw new Error(`readTraces failed: ${loaded.message}`)
    expect(loaded.traces.some((t) => !t.ok)).toBe(true)
    const res = pristineReconstruct(currentAfterT1T2(), loaded.traces, ["msg-a", "msg-b"])
    if (res.ok) throw new Error("expected refuse")
    expect(res.reason).toBe("corrupt-trace")
  })
})

describe("buildRestoreOps", () => {
  function pristineOfBoth(): ReadonlyMap<string, readonly PartLike[]> {
    return new Map([
      ["msg-a", [PRISTINE_A1]],
      ["msg-b", [PRISTINE_B1]],
    ])
  }

  test("restore de traza vieja tras una nueva: huérfano prt-d2 va a DELETE", () => {
    const res = buildRestoreOps(currentAfterT1T2(), pristineOfBoth(), ["msg-a", "msg-b"])
    if (!res.ok) throw new Error("expected ok")
    const deletes = res.ops.filter((op) => op.kind === "delete")
    const deleteIDs = deletes.map((op) => (op.kind === "delete" ? op.partID : ""))
    expect(deleteIDs).toContain("prt-d1")
    expect(deleteIDs).toContain("prt-d2")
    const updates = res.ops.filter((op) => op.kind === "update")
    expect(updates.length).toBe(2)
  })

  test("orden UPDATEs→DELETEs (crash-safety: sobre-lleno, nunca vacío)", () => {
    const res = buildRestoreOps(currentAfterT1T2(), pristineOfBoth(), ["msg-a", "msg-b"])
    if (!res.ok) throw new Error("expected ok")
    const kinds = res.ops.map((op) => op.kind)
    const lastUpdate = kinds.lastIndexOf("update")
    const firstDelete = kinds.indexOf("delete")
    expect(lastUpdate).toBeGreaterThanOrEqual(0)
    expect(firstDelete).toBeGreaterThanOrEqual(0)
    expect(lastUpdate).toBeLessThan(firstDelete)
  })

  test("update lleva el original VERBATIM (spread)", () => {
    const res = buildRestoreOps(currentAfterT1T2(), pristineOfBoth(), ["msg-a", "msg-b"])
    if (!res.ok) throw new Error("expected ok")
    const updateA = res.ops.find((op) => op.kind === "update" && op.messageID === "msg-a")
    if (updateA?.kind !== "update") throw new Error("expected update op for msg-a")
    expect(updateA.part).toEqual(PRISTINE_A1)
  })

  test("ops solo dentro del stretch de T (I5): msg-c intacto", () => {
    const current = new Map(currentAfterT1T2())
    current.set("msg-c", [textPart("msg-c", "prt-c9", "contenido ajeno")])
    const res = buildRestoreOps(current, pristineOfBoth(), ["msg-a", "msg-b"])
    if (!res.ok) throw new Error("expected ok")
    expect(res.ops.some((op) => op.messageID === "msg-c")).toBe(false)
  })

  test("parte fuera del allowlist I4 → refuse (sin merge creativo)", () => {
    const pristine = new Map(pristineOfBoth())
    const bad: PartLike = {
      id: "prt-a1",
      sessionID: SES,
      messageID: "msg-a",
      type: "snapshot",
      text: "x",
    }
    pristine.set("msg-a", [bad])
    const res = buildRestoreOps(currentAfterT1T2(), pristine, ["msg-a", "msg-b"])
    if (res.ok) throw new Error("expected refuse")
    expect(res.reason).toBe("disallowed-part-type")
  })

  test("pristine == current → cero ops", () => {
    const pristine = pristineOfBoth()
    const res = buildRestoreOps(pristine, pristine, ["msg-a", "msg-b"])
    if (!res.ok) throw new Error("expected ok")
    expect(res.ops).toEqual([])
  })
})
