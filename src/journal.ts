// Journal/trace sidecar JSONL append-only (diseño §9, DEC-4.4).
// Primera línea = TraceEntry completo con status "planned" (write-ahead);
// transiciones = líneas appended; la ÚLTIMA línea manda.
// Append-only: jamás se reescriben líneas existentes.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TraceEntry } from "./pure.js"

export type { TraceEntry }

export type TraceStatus = TraceEntry["status"]

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "executing",
  "done",
  "partial",
  "restored",
])

/** Línea de transición de status (shape fijado por DEC-4.4). */
export type StatusTransition = {
  statusTransition: true
  status: TraceStatus
  at: number
}

export type JournalErrorReason =
  | "invalid-entry"
  | "invalid-status"
  | "invalid-ts"
  | "trace-not-found"
  | "io-error"

export type JournalError = { ok: false; reason: JournalErrorReason; message: string }

export type AppendPlannedResult = { ok: true; file: string; ts: number } | JournalError

export type AppendStatusResult = { ok: true; file: string } | JournalError

/** Traza leída: sana con status vigente, o corrupta (refuse, jamás parse parcial). */
export type ReadTrace =
  | { ok: true; ts: number; file: string; entry: TraceEntry; status: TraceStatus }
  | { ok: false; reason: "corrupt"; file: string; message: string }

export type ReadTracesResult = { ok: true; traces: readonly ReadTrace[] } | JournalError

export type LatestTraceResult = { ok: true; trace: ReadTrace | undefined } | JournalError

function fail(reason: JournalErrorReason, message: string): JournalError {
  return { ok: false, reason, message }
}

/** Path canónico: <directory>/.opencode/distill/<sessionID>/<ts>.jsonl */
export function traceFilePath(directory: string, sessionID: string, ts: number): string {
  return join(directory, ".opencode", "distill", sessionID, `${ts}.jsonl`)
}

function sessionDir(directory: string, sessionID: string): string {
  return join(directory, ".opencode", "distill", sessionID)
}

function isValidTs(ts: number): boolean {
  return Number.isInteger(ts) && ts >= 0
}

function isTraceEntry(value: unknown): value is TraceEntry {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v["version"] === 1 &&
    typeof v["sessionID"] === "string" &&
    typeof v["createdAt"] === "number" &&
    Array.isArray(v["stretch"]) &&
    Array.isArray(v["originals"]) &&
    Array.isArray(v["createdPartIDs"]) &&
    Array.isArray(v["plan"]) &&
    typeof v["distillate"] === "object" &&
    v["distillate"] !== null &&
    typeof v["status"] === "string" &&
    VALID_STATUSES.has(v["status"] as string)
  )
}

function isStatusTransition(value: unknown): value is StatusTransition {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v["statusTransition"] === true &&
    typeof v["status"] === "string" &&
    VALID_STATUSES.has(v["status"] as string) &&
    typeof v["at"] === "number"
  )
}

/**
 * Write-ahead "planned": mkdir recursive + escritura atómica
 * (todo el archivo a <ts>.jsonl.tmp + renameSync). Sin .tmp remanente en éxito.
 */
export function appendPlanned(
  directory: string,
  entry: TraceEntry,
  ts: number,
): AppendPlannedResult {
  if (!isValidTs(ts)) return fail("invalid-ts", `Invalid trace timestamp: ${ts}`)
  if (entry.status !== "planned" || !isTraceEntry(entry)) {
    return fail("invalid-entry", "TraceEntry must be complete with status planned")
  }
  const file = traceFilePath(directory, entry.sessionID, ts)
  const tmp = `${file}.tmp`
  try {
    mkdirSync(sessionDir(directory, entry.sessionID), { recursive: true })
    writeFileSync(tmp, JSON.stringify(entry) + "\n", "utf8")
    renameSync(tmp, file)
    return { ok: true, file, ts }
  } catch (error) {
    return fail("io-error", `Cannot write trace ${file}: ${String(error)}`)
  }
}

/** Append de transición: jamás reescribe líneas existentes (append-only). */
export function appendStatus(
  directory: string,
  sessionID: string,
  ts: number,
  status: string,
  at: number,
): AppendStatusResult {
  if (!isValidTs(ts)) return fail("invalid-ts", `Invalid trace timestamp: ${ts}`)
  if (!VALID_STATUSES.has(status)) {
    return fail("invalid-status", `Invalid trace status: ${status}`)
  }
  const file = traceFilePath(directory, sessionID, ts)
  if (!existsSync(file)) {
    return fail("trace-not-found", `Trace not found: ${file}`)
  }
  const line: StatusTransition = { statusTransition: true, status: status as TraceStatus, at }
  try {
    appendFileSync(file, JSON.stringify(line) + "\n", "utf8")
    return { ok: true, file }
  } catch (error) {
    return fail("io-error", `Cannot append status to ${file}: ${String(error)}`)
  }
}

function parseTraceFile(file: string, ts: number): ReadTrace {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (error) {
    return { ok: false, reason: "corrupt", file, message: `Cannot read ${file}: ${String(error)}` }
  }
  const lines = raw.split("\n").filter((line) => line.length > 0)
  if (lines.length === 0) {
    return { ok: false, reason: "corrupt", file, message: `Empty trace: ${file}` }
  }
  const firstRaw = lines[0] as string
  let first: unknown
  try {
    first = JSON.parse(firstRaw)
  } catch {
    return { ok: false, reason: "corrupt", file, message: `Invalid first line in ${file}` }
  }
  if (!isTraceEntry(first)) {
    return { ok: false, reason: "corrupt", file, message: `Invalid entry in ${file}` }
  }
  let status: TraceStatus = first.status
  for (const line of lines.slice(1)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return { ok: false, reason: "corrupt", file, message: `Invalid line in ${file}` }
    }
    if (!isStatusTransition(parsed)) {
      return { ok: false, reason: "corrupt", file, message: `Invalid transition in ${file}` }
    }
    // Last-line-wins: cada transición válida reemplaza el status vigente.
    status = parsed.status
  }
  return { ok: true, ts, file, entry: first, status }
}

/**
 * Lista *.jsonl desc por nombre (ts); full-parse de CADA línea.
 * Un archivo con UNA línea inválida → refuse de ese archivo (corrupt),
 * sin envenenar a los sanos (distill disjunto sigue, DEC-4.5).
 */
export function readTraces(directory: string, sessionID: string): ReadTracesResult {
  const dir = sessionDir(directory, sessionID)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { ok: true, traces: [] }
    return fail("io-error", `Cannot list traces in ${dir}: ${String(error)}`)
  }
  const files = names
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .reverse()
  const traces: ReadTrace[] = []
  for (const name of files) {
    const ts = Number(name.slice(0, -".jsonl".length))
    if (!isValidTs(ts)) {
      traces.push({
        ok: false,
        reason: "corrupt",
        file: join(dir, name),
        message: `Invalid trace name: ${name}`,
      })
      continue
    }
    traces.push(parseTraceFile(join(dir, name), ts))
  }
  return { ok: true, traces }
}

/** La traza más nueva de la sesión (D4: restore sin arg = latest). */
export function latestTrace(directory: string, sessionID: string): LatestTraceResult {
  const res = readTraces(directory, sessionID)
  if (!res.ok) return res
  const first = res.traces[0]
  return { ok: true, trace: first }
}
