// Journal/trace sidecar JSONL append-only (diseño §9, DEC-4.4).
// Primera línea = TraceEntry completo con status "planned" (write-ahead);
// transiciones = líneas appended; la ÚLTIMA línea manda.
// Append-only: jamás se reescriben líneas existentes.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { PartLike, PartOp, TraceEntry } from "./pure.js"

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

// --- Cadena completa DEC-4: pristineReconstruct + buildRestoreOps (task #11). ---
// Inversión reverse-cronológica de trazas intersectantes (status-independiente,
// idempotente); restore = write-diff prístino-vs-actual (UPDATEs→DELETEs).

/** Tipos de parte mutables (allowlist I4, espejo de pure.ts). */
const MUTABLE_PART_TYPES: ReadonlySet<string> = new Set(["text", "reasoning", "tool"])

export type ChainErrorReason = "corrupt-trace" | "disallowed-part-type"

export type ChainError = { ok: false; reason: ChainErrorReason; message: string }

/** Trazas cuyo stretch intersecta los mensajes objetivo (sanas o corruptas). */
export function intersectingTraces(
  traces: readonly ReadTrace[],
  messageIDs: readonly string[],
): readonly ReadTrace[] {
  const wanted = new Set(messageIDs)
  return traces.filter((trace) => {
    if (!trace.ok) {
      // La corrupta no tiene stretch legible: se conserva para que el
      // consumidor la refuse (Metis F3), no se filtra en silencio.
      return true
    }
    return trace.entry.stretch.some((id) => wanted.has(id))
  })
}

export type PristineResult =
  | { ok: true; pristine: ReadonlyMap<string, readonly PartLike[]> }
  | ChainError

function samePartContent(a: PartLike, b: PartLike): boolean {
  return (
    a.id === b.id &&
    a.sessionID === b.sessionID &&
    a.messageID === b.messageID &&
    a.type === b.type &&
    a.text === b.text &&
    a.synthetic === b.synthetic &&
    a.state?.status === b.state?.status &&
    a.state?.output === b.state?.output &&
    a.state?.error === b.state?.error &&
    JSON.stringify(a.metadata ?? null) === JSON.stringify(b.metadata ?? null)
  )
}

/**
 * Reconstruye el contenido prístino: parte del estado actual y aplica las
 * trazas intersectantes en orden NEWEST→OLDEST; por traza: (1) upsert de cada
 * original verbatim, (2) remoción de createdPartIDs. Idempotente por
 * construcción (invertir lo ya invertido = no-op). Traza corrupta
 * intersectante → refuse corrupt-trace.
 */
export function pristineReconstruct(
  partsByMessage: ReadonlyMap<string, readonly PartLike[]>,
  traces: readonly ReadTrace[],
  messageIDs: readonly string[],
): PristineResult {
  const wanted = new Set(messageIDs)
  const hits = intersectingTraces(traces, messageIDs)
  for (const trace of hits) {
    if (!trace.ok) {
      return { ok: false, reason: "corrupt-trace", message: `Corrupt trace: ${trace.file}` }
    }
  }
  // Copia mutable por mensaje objetivo; el resto de los mensajes no se toca.
  const out = new Map<string, PartLike[]>()
  for (const id of wanted) {
    out.set(id, [...(partsByMessage.get(id) ?? [])])
  }
  // Orden NEWEST→OLDEST garantizado acá adentro (no se confía en el orden
  // de entrada; no se muta el array del llamador).
  const ordered = [...hits].sort((a, b) => (b.ok ? b.ts : -1) - (a.ok ? a.ts : -1))
  for (const trace of ordered) {
    if (!trace.ok) continue
    const created = new Set(trace.entry.createdPartIDs)
    for (const { messageID, part } of trace.entry.originals) {
      if (!wanted.has(messageID)) continue
      const parts = out.get(messageID) ?? []
      const idx = parts.findIndex((p) => p.id === part.id)
      if (idx >= 0) {
        parts[idx] = { ...part }
      } else {
        parts.push({ ...part })
      }
      out.set(messageID, parts)
    }
    for (const [messageID, parts] of out) {
      out.set(
        messageID,
        parts.filter((p) => !created.has(p.id)),
      )
    }
  }
  const pristine = new Map<string, readonly PartLike[]>()
  for (const [id, parts] of out) {
    pristine.set(id, parts)
  }
  return { ok: true, pristine }
}

export type RestoreOpsResult = { ok: true; ops: readonly PartOp[] } | ChainError

/**
 * Write-diff prístino-vs-actual dentro del stretch de T (I5): prístino
 * ausente/cambiado en actual → update (spread del original verbatim);
 * actual sin prístino → delete. Orden UPDATEs→DELETEs (crash-safety).
 * Las partes fuera del allowlist I4 (step-start/step-finish/…) se SALTEAN
 * en ambos loops: jamás generan ops. I4 defensivo sobre lo emitido
 * (por construcción solo text/reasoning/tool).
 */
export function buildRestoreOps(
  currentParts: ReadonlyMap<string, readonly PartLike[]>,
  pristine: ReadonlyMap<string, readonly PartLike[]>,
  stretchMessageIDs: readonly string[],
): RestoreOpsResult {
  const wanted = new Set(stretchMessageIDs)
  const updates: PartOp[] = []
  const deletes: PartOp[] = []
  for (const messageID of wanted) {
    const current = currentParts.get(messageID) ?? []
    const want = pristine.get(messageID) ?? []
    const currentByID = new Map(current.map((p) => [p.id, p]))
    const wantByID = new Map(want.map((p) => [p.id, p]))
    for (const part of want) {
      if (!MUTABLE_PART_TYPES.has(part.type)) continue
      const cur = currentByID.get(part.id)
      if (cur === undefined || !samePartContent(cur, part)) {
        updates.push({ kind: "update", messageID, part: { ...part } })
      }
    }
    for (const part of current) {
      if (!MUTABLE_PART_TYPES.has(part.type)) continue
      if (!wantByID.has(part.id)) {
        deletes.push({ kind: "delete", messageID, partID: part.id })
      }
    }
  }
  for (const op of [...updates, ...deletes]) {
    const emittedType = op.kind === "update" ? op.part.type : currentParts.get(op.messageID)?.find((p) => p.id === op.partID)?.type
    if (emittedType !== undefined && !MUTABLE_PART_TYPES.has(emittedType)) {
      return {
        ok: false,
        reason: "disallowed-part-type",
        message: `Disallowed part type in restore: ${emittedType}`,
      }
    }
  }
  return { ok: true, ops: [...updates, ...deletes] }
}
