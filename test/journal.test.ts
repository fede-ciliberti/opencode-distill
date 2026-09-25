// Tests del journal/trace JSONL (diseño §9, DEC-4.4, task #10).
// Failing-first: importan de ../src/journal.js (regla dura).
// FS REAL (os.tmpdir + mkdtempSync por test); JAMÁS fakes de FS (Metis F10).
import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendPlanned,
  appendStatus,
  latestTrace,
  readTraces,
  traceFilePath,
  type TraceEntry,
} from "../src/journal.js"
import type { TraceEntry as PureTraceEntry } from "../src/pure.js"

// El journal re-exporta el tipo de pure: compatibilidad estática.
const _typeCheck: PureTraceEntry | undefined = undefined as TraceEntry | undefined
void _typeCheck

let scratch: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "journal-"))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true })
  }
  scratch = []
})

// Entrada mínima válida: status planned, stretch con 2 mensajes.
function plannedEntry(sessionID: string, at = 1700000000000): TraceEntry {
  return {
    version: 1,
    sessionID,
    createdAt: at,
    stretch: ["msg-a", "msg-b"],
    originals: [
      {
        messageID: "msg-a",
        part: { id: "prt-1", sessionID, messageID: "msg-a", type: "text", text: "hola" },
      },
    ],
    createdPartIDs: [],
    plan: [],
    distillate: {
      summary: "resumen",
      stubs: { "msg-b": "hizo algo" },
      model: { providerID: "p", modelID: "m" },
    },
    status: "planned",
  }
}

describe("traceFilePath", () => {
  test("arma <directory>/.opencode/distill/<sessionID>/<ts>.jsonl", () => {
    const dir = freshDir()
    expect(traceFilePath(dir, "ses-1", 123)).toBe(
      join(dir, ".opencode", "distill", "ses-1", "123.jsonl"),
    )
  })
})

describe("appendPlanned", () => {
  test("crea el path profundo y la primera línea es el entry completo planned", () => {
    const dir = freshDir()
    const entry = plannedEntry("ses-1")
    const res = appendPlanned(dir, entry, 1000)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.file).toBe(join(dir, ".opencode", "distill", "ses-1", "1000.jsonl"))
    const raw = readFileSync(res.file, "utf8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0] as string) as TraceEntry
    expect(parsed).toEqual({ ...entry, status: "planned" })
  })

  test("escritura atómica: no deja .tmp remanente en éxito", () => {
    const dir = freshDir()
    const res = appendPlanned(dir, plannedEntry("ses-1"), 1000)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const files = readdirSync(join(dir, ".opencode", "distill", "ses-1"))
    expect(files).toEqual(["1000.jsonl"])
    expect(existsSync(res.file + ".tmp")).toBe(false)
  })

  test("mkdir profundo: directory anidado inexistente se crea recursive", () => {
    const base = freshDir()
    const deep = join(base, "a", "b", "c")
    const res = appendPlanned(deep, plannedEntry("ses-1"), 1000)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(existsSync(res.file)).toBe(true)
  })

  test("entry con status no-planned → error tipado, sin throw crudo", () => {
    const dir = freshDir()
    const entry = { ...plannedEntry("ses-1"), status: "done" as const }
    const res = appendPlanned(dir, entry, 1000)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe("invalid-entry")
  })
})

describe("appendStatus", () => {
  test("append-only: la primera línea queda intacta y se agrega la transición", () => {
    const dir = freshDir()
    const entry = plannedEntry("ses-1")
    const planned = appendPlanned(dir, entry, 1000)
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const before = readFileSync(planned.file, "utf8")
    const appended = appendStatus(dir, "ses-1", 1000, "done", 2000)
    expect(appended.ok).toBe(true)
    const after = readFileSync(planned.file, "utf8")
    // Inmutabilidad append-only: el contenido previo es prefijo exacto.
    expect(after.startsWith(before)).toBe(true)
    const lines = after.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe(before.trimEnd())
    expect(JSON.parse(lines[1] as string)).toEqual({
      statusTransition: true,
      status: "done",
      at: 2000,
    })
  })

  test("status inválido → error tipado sin tocar el archivo", () => {
    const dir = freshDir()
    const planned = appendPlanned(dir, plannedEntry("ses-1"), 1000)
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const before = readFileSync(planned.file, "utf8")
    const res = appendStatus(dir, "ses-1", 1000, "bogus-status", 2000)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe("invalid-status")
    expect(readFileSync(planned.file, "utf8")).toBe(before)
  })

  test("archivo inexistente → error tipado, sin throw", () => {
    const dir = freshDir()
    const res = appendStatus(dir, "ses-1", 9999, "done", 2000)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe("trace-not-found")
  })
})

describe("readTraces", () => {
  test("last-line-wins: planned + executing + done → done", () => {
    const dir = freshDir()
    expect(appendPlanned(dir, plannedEntry("ses-1"), 1000).ok).toBe(true)
    expect(appendStatus(dir, "ses-1", 1000, "executing", 1100).ok).toBe(true)
    expect(appendStatus(dir, "ses-1", 1000, "done", 1200).ok).toBe(true)
    const res = readTraces(dir, "ses-1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.traces.length).toBe(1)
    const first = res.traces[0]
    expect(first?.ok).toBe(true)
    if (!first?.ok) return
    expect(first.status).toBe("done")
    expect(first.entry.status).toBe("planned")
    expect(first.ts).toBe(1000)
  })

  test("sin transiciones: el status vigente es el del entry", () => {
    const dir = freshDir()
    expect(appendPlanned(dir, plannedEntry("ses-1"), 1000).ok).toBe(true)
    const res = readTraces(dir, "ses-1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const first = res.traces[0]
    expect(first?.ok).toBe(true)
    if (!first?.ok) return
    expect(first.status).toBe("planned")
  })

  test("lista desc por nombre (ts): la más nueva primero", () => {
    const dir = freshDir()
    expect(appendPlanned(dir, plannedEntry("ses-1"), 1000).ok).toBe(true)
    expect(appendPlanned(dir, plannedEntry("ses-1"), 3000).ok).toBe(true)
    expect(appendPlanned(dir, plannedEntry("ses-1"), 2000).ok).toBe(true)
    const res = readTraces(dir, "ses-1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const tsList = res.traces.map((t) => (t.ok ? t.ts : -1))
    expect(tsList).toEqual([3000, 2000, 1000])
  })

  test("corrupta: UNA línea inválida → refuse de ese archivo, jamás parse parcial", () => {
    const dir = freshDir()
    expect(appendPlanned(dir, plannedEntry("ses-1"), 1000).ok).toBe(true)
    // Trunco a mano: agrego basura tras la primera línea válida.
    const file = traceFilePath(dir, "ses-1", 1000)
    const raw = readFileSync(file, "utf8")
    appendFileSync(file, '{"statusTransition":true,"status":\n')
    expect(raw.split("\n").filter((l) => l.length > 0).length).toBe(1)
    const res = readTraces(dir, "ses-1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.traces.length).toBe(1)
    const first = res.traces[0]
    expect(first?.ok).toBe(false)
    if (first?.ok) return
    expect(first.reason).toBe("corrupt")
    expect(first.file).toBe(file)
  })

  test("corrupta no envenena a la sana: distill disjunto sigue (DEC-4.5)", () => {
    const dir = freshDir()
    expect(appendPlanned(dir, plannedEntry("ses-1"), 1000).ok).toBe(true)
    expect(appendPlanned(dir, plannedEntry("ses-1"), 2000).ok).toBe(true)
    appendFileSync(traceFilePath(dir, "ses-1", 1000), "basura-no-json\n")
    const res = readTraces(dir, "ses-1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.traces.length).toBe(2)
    // Orden desc: 2000 sana primero, 1000 corrupta después.
    expect(res.traces[0]?.ok).toBe(true)
    expect(res.traces[1]?.ok).toBe(false)
  })

  test("sesión sin trazas → lista vacía ok (dir inexistente no es error)", () => {
    const dir = freshDir()
    const res = readTraces(dir, "ses-vacia")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.traces).toEqual([])
  })

  test("ignora archivos no-.jsonl y .tmp remanentes", () => {
    const dir = freshDir()
    expect(appendPlanned(dir, plannedEntry("ses-1"), 1000).ok).toBe(true)
    const sessionDir = join(dir, ".opencode", "distill", "ses-1")
    writeFileSync(join(sessionDir, "notas.txt"), "hola")
    writeFileSync(join(sessionDir, "9999.jsonl.tmp"), "{}")
    const res = readTraces(dir, "ses-1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.traces.length).toBe(1)
  })
})

describe("latestTrace", () => {
  test("devuelve la más nueva; undefined si no hay trazas", () => {
    const dir = freshDir()
    const empty = latestTrace(dir, "ses-1")
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(empty.trace).toBeUndefined()
    expect(appendPlanned(dir, plannedEntry("ses-1"), 1000).ok).toBe(true)
    expect(appendPlanned(dir, plannedEntry("ses-1"), 2000).ok).toBe(true)
    const res = latestTrace(dir, "ses-1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.trace?.ok).toBe(true)
    if (!res.trace?.ok) return
    expect(res.trace.ts).toBe(2000)
  })
})
