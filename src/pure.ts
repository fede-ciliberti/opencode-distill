// Lógica pura de selección de stretch y tipos (diseño §3 + §4).
// Sin dependencias, sin efectos, sin acceso a `api`. Sin importar el SDK.
//
// Convenciones: copy de UI en inglés, comentarios en español rioplatense.
import { estTokens } from "./distill.js"

/** Parte de un mensaje (forma mínima que consume el plugin). */
export type PartLike = {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  synthetic?: boolean
  metadata?: Readonly<Record<string, unknown>>
  state?: { status: string; output?: string; error?: string }
}

/** Mensaje de usuario (forma mínima que consume el plugin). */
export type UserMessageLike = {
  id: string
  role: "user"
  time: { created: number }
  parts: readonly PartLike[]
}

/** Mensaje de assistant (forma mínima que consume el plugin). */
export type AssistantMessageLike = {
  id: string
  role: "assistant"
  time: { created: number }
  summary?: boolean
  parts: readonly PartLike[]
}

export type MessageLike = UserMessageLike | AssistantMessageLike

/** Type-guard: distingue assistants dentro de la unión. */
export function isAssistantMessage(m: MessageLike): m is AssistantMessageLike {
  return m.role === "assistant"
}

/** Tipos de parte mutables (allowlist I4). */
export type PartTypeName = "text" | "reasoning" | "tool"

/** Filtro de tipos: qué buckets de masa cuentan para el stretch. */
export type TypeFilter = ReadonlySet<PartTypeName>

/** Especificación de stretch (UX §4: turno actual, últimos n, rango v2). */
export type StretchSpec =
  | { kind: "current-turn" }
  | { kind: "last-n"; n: number }
  | { kind: "range"; firstID: string; lastID: string }

export type Stretch = {
  sessionID: string
  directory: string
  messageIDs: readonly string[]
}

export type Distillate = {
  summary: string
  stubs: Readonly<Record<string, string>>
  model: { providerID: string; modelID: string }
}

export type PartOp =
  | { kind: "update"; messageID: string; part: PartLike }
  | { kind: "delete"; messageID: string; partID: string }

export type RewritePlan = {
  stretch: Stretch
  ops: readonly PartOp[]
  mass: {
    beforeChars: number
    afterChars: number
    cacheInvalidationFrom: string
    estBreakEvenTurns: number
  }
}

export type TraceEntry = {
  version: 1
  sessionID: string
  createdAt: number
  stretch: readonly string[]
  originals: ReadonlyArray<{ messageID: string; part: PartLike }>
  createdPartIDs: readonly string[]
  plan: readonly PartOp[]
  distillate: Distillate
  status: "planned" | "executing" | "done" | "partial" | "restored"
}

/** Masa mínima del stretch en chars seleccionados (diseño §4, VALIDATE). */
export const MIN_STRETCH_CHARS = 500

export type CharsByType = { text: number; reasoning: number; tool: number }

const TOOL_DONE_STATUSES: ReadonlySet<string> = new Set(["completed", "error"])

/**
 * Masa por bucket: text suma `.text` de partes text; reasoning lo propio;
 * tool suma `state.output ?? state.error` solo con status completed/error
 * (el SDK no tiene `output` en error: se cuenta el string de error).
 * El resto de los tipos aporta 0.
 */
export function charsByType(parts: readonly PartLike[]): CharsByType {
  let text = 0
  let reasoning = 0
  let tool = 0
  for (const part of parts) {
    if (part.type === "text") {
      text += part.text?.length ?? 0
    } else if (part.type === "reasoning") {
      reasoning += part.text?.length ?? 0
    } else if (part.type === "tool") {
      const status = part.state?.status
      if (status !== undefined && TOOL_DONE_STATUSES.has(status)) {
        tool += (part.state?.output ?? part.state?.error)?.length ?? 0
      }
    }
  }
  return { text, reasoning, tool }
}

/** Suma solo los buckets incluidos en el filtro de tipos. */
export function selectedChars(parts: readonly PartLike[], types: TypeFilter): number {
  const buckets = charsByType(parts)
  let total = 0
  if (types.has("text")) total += buckets.text
  if (types.has("reasoning")) total += buckets.reasoning
  if (types.has("tool")) total += buckets.tool
  return total
}

const VALID_TYPES: ReadonlySet<string> = new Set(["text", "reasoning", "tool"])

/**
 * Parsea la spec de tipos: trim, split en /[\s,]+/, lowercase; cada token
 * tiene que estar en {text,reasoning,tool} o es invalid; vacío → invalid;
 * duplicados colapsan por Set.
 */
export function parseTypeSpec(raw: string): TypeFilter | { kind: "invalid" } {
  const trimmed = raw.trim()
  if (trimmed === "") return { kind: "invalid" }
  const tokens = trimmed.split(/[\s,]+/)
  const out = new Set<PartTypeName>()
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (!VALID_TYPES.has(lower)) return { kind: "invalid" }
    out.add(lower as PartTypeName)
  }
  if (out.size === 0) return { kind: "invalid" }
  return out
}

/**
 * Frontera de compactación: messageID del ÚLTIMO mensaje con una parte
 * `type==="compaction"` (forma W0: vive en mensaje user, sin tail_start_id).
 */
export function findCompactionBoundary(
  messages: readonly MessageLike[],
): string | undefined {
  let found: string | undefined = undefined
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "compaction") {
        found = message.id
        break
      }
    }
  }
  return found
}

export type SelectErrorKind =
  | "empty-stretch"
  | "stretch-crosses-user-message"
  | "stretch-behind-compaction"
  | "stretch-contains-summary"
  | "stretch-contains-compaction"
  | "not-enough-messages"
  | "message-not-found"
  | "no-distillable-content"
  | "stretch-too-small"

export type SelectResult =
  | { ok: true; messageIDs: readonly string[] }
  | { ok: false; kind: SelectErrorKind; message: string }

// NOTA: devuelve `messageIDs` (la selección), NO un `Stretch` completo:
// esta función no recibe sessionID/directory; el flow enriquece después.

function fail(kind: SelectErrorKind, message: string): SelectResult {
  return { ok: false, kind, message }
}

function indexById(messages: readonly MessageLike[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>()
  messages.forEach((m, i) => {
    if (!map.has(m.id)) map.set(m.id, i)
  })
  return map
}

function lastUserIndex(messages: readonly MessageLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i
  }
  return -1
}

/**
 * Resuelve el spec a un span de índices y valida en orden fijo:
 * empty → user dentro → behind-compaction → summary → compaction →
 * masa 0 → masa < mínimo. El orden importa: cada guard tiene su kind.
 */
export function selectStretch(
  messages: readonly MessageLike[],
  spec: StretchSpec,
  boundary: string | undefined,
  types: TypeFilter,
): SelectResult {
  // 1. Resolver el span según el spec.
  let start = 0
  let end = messages.length - 1
  if (spec.kind === "current-turn") {
    start = lastUserIndex(messages) + 1
    end = messages.length - 1
  } else if (spec.kind === "last-n") {
    if (!Number.isInteger(spec.n) || spec.n < 1) {
      return fail("not-enough-messages", `Not enough assistant messages for last-${spec.n}`)
    }
    const assistants: number[] = []
    messages.forEach((m, i) => {
      if (isAssistantMessage(m)) assistants.push(i)
    })
    if (assistants.length < spec.n) {
      return fail(
        "not-enough-messages",
        `Not enough assistant messages for last-${spec.n} (have ${assistants.length})`,
      )
    }
    start = assistants[assistants.length - spec.n] ?? 0
    // El span termina en el último assistant, no al final de la lista:
    // un user posterior (turno nuevo sin respuesta) no es parte del stretch.
    end = assistants[assistants.length - 1] ?? 0
  } else {
    const byId = indexById(messages)
    const a = byId.get(spec.firstID)
    const b = byId.get(spec.lastID)
    if (a === undefined || b === undefined) {
      return fail("message-not-found", "Range endpoint not found in session")
    }
    start = Math.min(a, b)
    end = Math.max(a, b)
  }

  // 2. Span vacío.
  if (start > end || start >= messages.length) {
    return fail("empty-stretch", "Stretch is empty — nothing to distill")
  }

  // 3. User dentro del span.
  for (let i = start; i <= end; i++) {
    if (messages[i]?.role === "user") {
      return fail("stretch-crosses-user-message", "Stretch must contain only assistant messages")
    }
  }

  // 4. Frontera de compactación: el span arranca en/antes del boundary.
  if (boundary !== undefined) {
    const byId = indexById(messages)
    const b = byId.get(boundary)
    if (b !== undefined && start <= b) {
      return fail(
        "stretch-behind-compaction",
        "Stretch is at or before the compaction boundary — nothing to save",
      )
    }
  }

  // 5. Summary dentro.
  for (let i = start; i <= end; i++) {
    const m = messages[i]
    if (m !== undefined && isAssistantMessage(m) && m.summary === true) {
      return fail("stretch-contains-summary", "Stretch contains a compaction summary")
    }
  }

  // 6. Parte compaction dentro.
  for (let i = start; i <= end; i++) {
    const m = messages[i]
    if (m === undefined) continue
    for (const part of m.parts) {
      if (part.type === "compaction") {
        return fail("stretch-contains-compaction", "Stretch contains a compaction part")
      }
    }
  }

  // 7-8. Masa seleccionada.
  const parts: PartLike[] = []
  for (let i = start; i <= end; i++) {
    const m = messages[i]
    if (m !== undefined && isAssistantMessage(m)) parts.push(...m.parts)
  }
  const mass = selectedChars(parts, types)
  if (mass === 0) {
    return fail("no-distillable-content", "Stretch has no distillable content for these types")
  }
  if (mass < MIN_STRETCH_CHARS) {
    return fail(
      "stretch-too-small",
      `Stretch is too small (${mass} < ${MIN_STRETCH_CHARS} chars)`,
    )
  }

  const messageIDs: string[] = []
  for (let i = start; i <= end; i++) {
    const m = messages[i]
    if (m !== undefined) messageIDs.push(m.id)
  }
  return { ok: true, messageIDs }
}

// Plan builder: RewritePlan UPDATE→DELETE con IDs deterministas y modos por tipo (task #7, DEC-5).
// NOTA: `traceRef = hash8(stretch)` porque el builder no recibe el ts del trace;
// el flow lo reescribe al nombre real del archivo al persistir (task #11/#14).

export type PlanErrorKind = "allowlist-violation"

export class PlanError extends Error {
  readonly kind: PlanErrorKind
  constructor(kind: PlanErrorKind, message: string) {
    super(message)
    this.name = "PlanError"
    this.kind = kind
  }
}

/** FNV-1a-32 sobre UTF-8 → 8 hex lowercase. Implementación propia, sin deps. */
export function hash8(messageIDs: readonly string[]): string {
  const bytes = new TextEncoder().encode(messageIDs.join("\n"))
  let h = 0x811c9dc5
  for (const b of bytes) {
    h ^= b
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

function toolNameOf(part: PartLike): string {
  if ("tool" in part) {
    const withTool: { tool?: unknown } = part
    if (typeof withTool.tool === "string" && withTool.tool !== "") {
      return withTool.tool
    }
  }
  return "tool"
}

function isCreatedPartID(id: string): boolean {
  return id.startsWith("prt_distill_") || id.startsWith("prt_stub_")
}

/**
 * Construye el RewritePlan UPDATE→DELETE (diseño §6 paso 6, DEC-5).
 * UPSERTs primero (distillate + stubs + tool updates), DELETEs después.
 * Throw tipado `PlanError` ante tipo fuera del allowlist I4 (contra el tipo fetch-eado).
 */
export function buildRewritePlan(
  stretch: Stretch,
  parts: readonly PartLike[],
  distillate: Pick<Distillate, "summary" | "stubs">,
  types: TypeFilter,
): RewritePlan {
  const firstID = stretch.messageIDs[0]
  const inStretch = new Set<string>(stretch.messageIDs)
  const inside = parts.filter((p) => inStretch.has(p.messageID))

  for (const part of inside) {
    if (part.type !== "text" && part.type !== "reasoning" && part.type !== "tool") {
      throw new PlanError(
        "allowlist-violation",
        `Part ${part.id} has disallowed type "${part.type}" (allowlist: text/reasoning/tool)`,
      )
    }
  }

  if (firstID === undefined) {
    return {
      stretch,
      ops: [],
      mass: { beforeChars: 0, afterChars: 0, cacheInvalidationFrom: "", estBreakEvenTurns: 1 },
    }
  }

  const h = hash8(stretch.messageIDs)
  const wantText = types.has("text")
  const wantReasoning = types.has("reasoning")
  const wantTool = types.has("tool")

  const textsToDelete = wantText
    ? inside.filter(
        (p) => p.type === "text" && (p.text ?? "") !== "" && !isCreatedPartID(p.id),
      )
    : []
  const deletedTextByMessage = new Set<string>(textsToDelete.map((p) => p.messageID))
  const reasoningsToDelete = wantReasoning ? inside.filter((p) => p.type === "reasoning") : []
  const toolsToUpdate = wantTool
    ? inside.filter(
        (p) =>
          p.type === "tool" &&
          p.state?.status !== undefined &&
          TOOL_DONE_STATUSES.has(p.state.status),
      )
    : []

  const updates: Array<Extract<PartOp, { kind: "update" }>> = []
  updates.push({
    kind: "update",
    messageID: firstID,
    part: {
      id: `prt_distill_${h}`,
      sessionID: stretch.sessionID,
      messageID: firstID,
      type: "text",
      text: distillate.summary,
      synthetic: true,
      metadata: { distilled: true, traceRef: h, types: [...types] },
    },
  })

  for (const messageID of stretch.messageIDs.slice(1)) {
    if (!deletedTextByMessage.has(messageID)) continue
    const stub = distillate.stubs[messageID]
    if (stub === undefined || stub === "") continue
    updates.push({
      kind: "update",
      messageID,
      part: {
        id: `prt_stub_${messageID}`,
        sessionID: stretch.sessionID,
        messageID,
        type: "text",
        text: stub,
        synthetic: true,
        metadata: { stub: true, traceRef: h },
      },
    })
  }

  for (const original of toolsToUpdate) {
    const label = `[distilled] ${toolNameOf(original)} — see distillate`
    updates.push({
      kind: "update",
      messageID: original.messageID,
      part: {
        ...original,
        state: { ...original.state, status: original.state?.status ?? "completed", output: label },
        metadata: { ...original.metadata, preview: label },
      },
    })
  }

  const deleteIDs = new Set<string>([
    ...textsToDelete.map((p) => p.id),
    ...reasoningsToDelete.map((p) => p.id),
  ])
  const deletes: PartOp[] = []
  for (const part of inside) {
    if (deleteIDs.has(part.id)) {
      deletes.push({ kind: "delete", messageID: part.messageID, partID: part.id })
    }
  }

  const beforeChars = selectedChars(inside, types)
  const stubChars = updates
    .filter((o) => o.part.id.startsWith("prt_stub_"))
    .reduce((acc, o) => acc + (o.part.text ?? "").length, 0)
  const toolStubChars = updates
    .filter((o) => !o.part.id.startsWith("prt_distill_") && !o.part.id.startsWith("prt_stub_"))
    .reduce((acc, o) => acc + (o.part.state?.output ?? "").length, 0)
  const afterChars = distillate.summary.length + stubChars + toolStubChars
  const saving = beforeChars - afterChars
  const estBreakEvenTurns = saving <= 0 ? 1 : Math.max(1, Math.ceil(afterChars / saving))

  return {
    stretch,
    ops: [...updates, ...deletes],
    mass: { beforeChars, afterChars, cacheInvalidationFrom: firstID, estBreakEvenTurns },
  }
}

// --- Simulación de invariantes I1–I8 + hashes anti-drift (task #8). ---

/** JSON.stringify con keys recursivamente ordenadas (determinismo para hashes). */
export function stableStringify(value: unknown): string | undefined {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue)
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      out[k] = sortValue(obj[k])
    }
    return out
  }
  return value
}

/** FNV-1a-64 (bigint, implementación propia) sobre stableStringify(part) → hex 16 lowercase. */
export function partHash(part: PartLike): string {
  const str = stableStringify(part) ?? ""
  const bytes = new TextEncoder().encode(str)
  let h = 14695981039346656037n
  const prime = 1099511628211n
  const mask = (1n << 64n) - 1n
  for (const b of bytes) {
    h ^= BigInt(b)
    h = (h * prime) & mask
  }
  return h.toString(16).padStart(16, "0")
}

function deepCopyPart(part: PartLike): PartLike {
  return JSON.parse(JSON.stringify(part)) as PartLike
}

export type SnapshotForTraceResult = {
  originals: ReadonlyArray<{ messageID: string; part: PartLike }>
  hashes: ReadonlyArray<{ partID: string; hash: string }>
}

/**
 * Snapshot para el trace: originales verbatim de las partes mutables
 * (text/reasoning/tool) del stretch + hashes por parte para RE-VALID.
 */
export function snapshotForTrace(
  stretch: Stretch,
  partsByMessage: ReadonlyMap<string, readonly PartLike[]>,
): SnapshotForTraceResult {
  const allowed: ReadonlySet<string> = new Set(["text", "reasoning", "tool"])
  const originals: Array<{ messageID: string; part: PartLike }> = []
  const hashes: Array<{ partID: string; hash: string }> = []
  for (const messageID of stretch.messageIDs) {
    const parts = partsByMessage.get(messageID) ?? []
    for (const part of parts) {
      if (!allowed.has(part.type)) continue
      const copy = deepCopyPart(part)
      originals.push({ messageID, part: copy })
      hashes.push({ partID: part.id, hash: partHash(part) })
    }
  }
  return { originals, hashes }
}

export type SimulateResult =
  | { ok: true }
  | { ok: false; invariant: string; afterOpIndex?: number; message?: string }

export type SimulateOptions = {
  originals?: ReadonlyArray<{ messageID: string; part: PartLike }>
  userMessageIDs?: ReadonlySet<string>
}

/**
 * Simula el plan sobre una copia del estado y verifica I1–I8.
 * - Después de CADA op: I1 (todo mensaje del stretch retiene ≥1 parte visible:
 *   text/reasoning con texto no vacío, o tool con output/error no vacío).
 * - Al final: checklist I1–I8 completo (I2/I3/I4/I5/I6/I7/I8).
 * Usa las partes REALES pasadas en partsByMessage, no las esperadas.
 */
export function simulatePlan(
  plan: RewritePlan,
  partsByMessage: ReadonlyMap<string, readonly PartLike[]>,
  opts?: SimulateOptions,
): SimulateResult {
  const stretchSet = new Set<string>(plan.stretch.messageIDs)
  const allowedTypes: ReadonlySet<string> = new Set(["text", "reasoning", "tool"])

  // I7 upfront: compaction dentro del stretch (estado inicial).
  for (const messageID of plan.stretch.messageIDs) {
    const parts = partsByMessage.get(messageID) ?? []
    for (const part of parts) {
      if (part.type === "compaction") {
        return { ok: false, invariant: "I7", message: `Compaction part ${part.id} inside stretch` }
      }
    }
  }

  // Índices del estado inicial para I2/I4/I8.
  const initialIDs = new Set<string>()
  const initialPartByID = new Map<string, PartLike>()
  for (const messageID of plan.stretch.messageIDs) {
    const parts = partsByMessage.get(messageID) ?? []
    for (const part of parts) {
      initialIDs.add(part.id)
      if (!initialPartByID.has(part.id)) initialPartByID.set(part.id, part)
    }
  }

  // Copia profunda del estado para simular.
  const state = new Map<string, PartLike[]>()
  for (const [messageID, parts] of partsByMessage.entries()) {
    state.set(
      messageID,
      parts.map((p) => JSON.parse(JSON.stringify(p)) as PartLike),
    )
  }
  // Asegurar que todo mensaje del stretch exista en el mapa (aunque vacío).
  for (const messageID of plan.stretch.messageIDs) {
    if (!state.has(messageID)) state.set(messageID, [])
  }

  // NOTA F2: I1 sigue la OUTCOME del diseño (docs/01:162 "0 partes visibles"),
  // no la columna mecanismo ("≥1 text"): una tool part con output/error no
  // vacío es visible, así que un mensaje tool-only NO está vacío.
  function hasVisibleText(messageID: string): boolean {
    const parts = state.get(messageID) ?? []
    return parts.some((p) => {
      if (p.type === "text" || p.type === "reasoning") return (p.text ?? "") !== ""
      if (p.type === "tool") return ((p.state?.output ?? p.state?.error) ?? "") !== ""
      return false
    })
  }

  for (let i = 0; i < plan.ops.length; i++) {
    const op = plan.ops[i]
    if (op === undefined) continue

    // I5 localidad: op solo dentro del stretch.
    if (!stretchSet.has(op.messageID)) {
      return { ok: false, invariant: "I5", afterOpIndex: i, message: `Op outside stretch: ${op.messageID}` }
    }

    // I6 user messages inmutables (guard explícito).
    if (opts?.userMessageIDs?.has(op.messageID) === true) {
      return { ok: false, invariant: "I6", afterOpIndex: i, message: `Op on user message ${op.messageID}` }
    }

    // I4 allowlist sobre tipo fetch-eado y tipo nuevo.
    if (op.kind === "delete") {
      const existing = (state.get(op.messageID) ?? []).find((p) => p.id === op.partID)
      // Si no está en el estado copiado, buscar en el inicial (ya borrado en intermedio).
      const fetched = existing ?? initialPartByID.get(op.partID)
      if (fetched !== undefined && !allowedTypes.has(fetched.type)) {
        return { ok: false, invariant: "I4", afterOpIndex: i, message: `Delete of disallowed type ${fetched.type}` }
      }
      // También si el ID no existe, no es I4; se trata como no-op para I1.
    } else {
      const newType = op.part.type
      if (!allowedTypes.has(newType)) {
        return { ok: false, invariant: "I4", afterOpIndex: i, message: `Update to disallowed type ${newType}` }
      }
      const fetched = initialPartByID.get(op.part.id)
      if (fetched !== undefined && !allowedTypes.has(fetched.type)) {
        return { ok: false, invariant: "I4", afterOpIndex: i, message: `Update of disallowed fetched type ${fetched.type}` }
      }
    }

    // Aplicar op sobre la copia.
    if (op.kind === "update") {
      const arr = state.get(op.messageID) ?? []
      const idx = arr.findIndex((p) => p.id === op.part.id)
      const copy = JSON.parse(JSON.stringify(op.part)) as PartLike
      if (idx >= 0) {
        arr[idx] = copy
      } else {
        arr.push(copy)
      }
      state.set(op.messageID, arr)
    } else {
      const arr = state.get(op.messageID) ?? []
      state.set(
        op.messageID,
        arr.filter((p) => p.id !== op.partID),
      )
    }

    // I1 después de cada op: todo mensaje del stretch retiene ≥1 parte visible.
    for (const messageID of plan.stretch.messageIDs) {
      if (!hasVisibleText(messageID)) {
        return { ok: false, invariant: "I1", afterOpIndex: i, message: `Message ${messageID} left without visible text` }
      }
    }
  }

  // --- Checks finales I1–I8 (I1 ya cubierto, pero se re-verifica) ---

  // I1 final (redundante, ya verificado en intermedios).
  for (const messageID of plan.stretch.messageIDs) {
    if (!hasVisibleText(messageID)) {
      return { ok: false, invariant: "I1", message: `Final: message ${messageID} without visible text` }
    }
  }

  // I2 procedencia marcada: toda parte nueva (ID no en inicial) debe tener synthetic + marca.
  for (const messageID of plan.stretch.messageIDs) {
    const parts = state.get(messageID) ?? []
    for (const part of parts) {
      if (initialIDs.has(part.id)) continue
      const meta = part.metadata as Record<string, unknown> | undefined
      const hasSynthetic = part.synthetic === true
      const hasMark =
        meta !== undefined &&
        (meta["distilled"] === true || meta["stub"] === true) &&
        typeof meta["traceRef"] === "string" &&
        (meta["traceRef"] as string) !== ""
      if (!hasSynthetic || !hasMark) {
        return { ok: false, invariant: "I2", message: `New part ${part.id} without provenance mark` }
      }
    }
  }

  // I3 coherencia tool ↔ preview: solo para las tool parts que el plan reescribió
  // (docs/02:79-81: el preview del server es campo separado y puede ir stale en
  // tool parts intactas; exigir igualdad en todas rechazaría planes válidos).
  const rewrittenToolIDs = new Set<string>()
  for (const op of plan.ops) {
    if (op.kind === "update" && op.part.type === "tool") {
      rewrittenToolIDs.add(op.part.id)
    }
  }
  for (const messageID of plan.stretch.messageIDs) {
    const parts = state.get(messageID) ?? []
    for (const part of parts) {
      if (part.type !== "tool") continue
      if (!rewrittenToolIDs.has(part.id)) continue
      const output = part.state?.output
      const preview = (part.metadata as Record<string, unknown> | undefined)?.["preview"] as string | undefined
      if (output !== preview) {
        return { ok: false, invariant: "I3", message: `Tool ${part.id} preview != output` }
      }
    }
  }

  // I4 final: ya verificado por op, pero también verificar que no queden partes nuevas con tipo disallowed (defensa).
  for (const messageID of plan.stretch.messageIDs) {
    const parts = state.get(messageID) ?? []
    for (const part of parts) {
      if (!initialIDs.has(part.id) && !allowedTypes.has(part.type)) {
        return { ok: false, invariant: "I4", message: `Created part ${part.id} with disallowed type ${part.type}` }
      }
    }
  }

  // I5 ya verificado por op (localidad).

  // I6 ya verificado por op.

  // I7 ya verificado upfront.

  // I8 reversibilidad: snapshot de originales para el trace.
  if (plan.ops.length > 0) {
    if (opts?.originals === undefined || opts.originals.length === 0) {
      return { ok: false, invariant: "I8", message: "Missing originals snapshot for non-empty plan" }
    }
    const originalIDs = new Set<string>(opts.originals.map((o) => o.part.id))
    for (const op of plan.ops) {
      if (op.kind === "delete") {
        if (!originalIDs.has(op.partID)) {
          return { ok: false, invariant: "I8", message: `Delete ${op.partID} not in originals` }
        }
      } else {
        if (initialIDs.has(op.part.id) && !originalIDs.has(op.part.id)) {
          return { ok: false, invariant: "I8", message: `Update ${op.part.id} not in originals` }
        }
      }
    }
  }

  return { ok: true }
}

// --- Timeline de selección + estimaciones honestas (task #13, DEC-5, D11). ---
// Copy de UI en inglés; todo número de tokens lleva "(estimate)" (D11) y el
// ahorro de reasoning advierte dependencia del provider (docs/03:53-65).

/** Valor de una opción del DialogSelect de timeline (presets + filas From). */
export type StretchOptionValue = StretchSpec

export type StretchOption = {
  title: string
  description?: string
  value: StretchOptionValue
}

export type StretchOptions = {
  presets: readonly StretchOption[]
  rows: readonly StretchOption[]
}

/** Valor de una opción del DialogSelect de tipos (presets + Custom…). */
export type TypeOptionValue = TypeFilter | { custom: true }

export type TypeOption = {
  title: string
  value: TypeOptionValue
}

export type DistillEstimates = {
  cacheInvalidationFrom: string
  oneTimeRepriceTokens: number
  savingPerTurnTokens: number
  estBreakEvenTurns: number
}

export type ConfirmRange = { firstID: string; lastID: string }

export type RestoreTraceInfo = {
  createdAt: number
  stretch: readonly string[]
}

function firstTextOf(parts: readonly PartLike[]): string {
  for (const part of parts) {
    if (part.type === "text") return part.text ?? ""
  }
  return ""
}

const ALL_TYPES: TypeFilter = new Set<PartTypeName>(["text", "reasoning", "tool"])
const TEXT_REASONING: TypeFilter = new Set<PartTypeName>(["text", "reasoning"])
const REASONING_ONLY: TypeFilter = new Set<PartTypeName>(["reasoning"])
const TOOL_ONLY: TypeFilter = new Set<PartTypeName>(["tool"])

/**
 * Opciones puras para la cadena de diálogos del flow (DEC-5):
 * presets (Current turn / Last 3 / Last 5 / All) + una fila por mensaje
 * assistant elegible (post-boundary, no summary, con masa > 0). Cada fila
 * "From X" significa "desde X hasta el final"; la selección del End reusa
 * la misma lista (el flow la encadena).
 */
export function buildStretchOptions(
  messages: readonly MessageLike[],
  boundary: string | undefined,
): StretchOptions {
  const byId = indexById(messages)
  const startAfter = boundary === undefined ? -1 : (byId.get(boundary) ?? -1)

  const eligible: AssistantMessageLike[] = []
  for (let i = startAfter + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m === undefined || !isAssistantMessage(m)) continue
    if (m.summary === true) continue
    if (selectedChars(m.parts, ALL_TYPES) === 0) continue
    eligible.push(m)
  }

  const firstID = eligible[0]?.id ?? ""
  const lastID = eligible[eligible.length - 1]?.id ?? ""

  const presets: readonly StretchOption[] = [
    { title: "Current turn", value: { kind: "current-turn" } },
    { title: "Last 3", value: { kind: "last-n", n: 3 } },
    { title: "Last 5", value: { kind: "last-n", n: 5 } },
    { title: "All assistant messages", value: { kind: "range", firstID, lastID } },
  ]

  const rows: readonly StretchOption[] = eligible.map((m) => {
    const buckets = charsByType(m.parts)
    const total = buckets.text + buckets.reasoning + buckets.tool
    const preview = firstTextOf(m.parts).slice(0, 40)
    return {
      title: `From ${m.id}: "${preview}"`,
      description: `text ${buckets.text} · reasoning ${buckets.reasoning} · tool ${buckets.tool} (≈${estTokens(total)} tok, estimate)`,
      value: { kind: "range", firstID: m.id, lastID },
    }
  })

  return { presets, rows }
}

/** Presets del DialogSelect de tipos; "Custom…" lleva al DialogPrompt (parseTypeSpec). */
export function buildTypeOptions(): readonly TypeOption[] {
  return [
    { title: "Everything (text + reasoning + tool outputs)", value: ALL_TYPES },
    { title: "Everything but tool outputs", value: TEXT_REASONING },
    { title: "Reasoning only", value: REASONING_ONLY },
    { title: "Tool outputs only", value: TOOL_ONLY },
    { title: "Custom…", value: { custom: true } },
  ]
}

/**
 * Breakdown por tipo para el DialogConfirm: totales por bucket sobre las
 * partes ya filtradas al stretch, con tokens estimados y suffix de
 * provider-dependence cuando reasoning está en los tipos.
 */
export function buildTypeBreakdown(
  parts: readonly PartLike[],
  types: TypeFilter,
): string {
  const buckets = charsByType(parts)
  const text = types.has("text") ? buckets.text : 0
  const reasoning = types.has("reasoning") ? buckets.reasoning : 0
  const tool = types.has("tool") ? buckets.tool : 0
  const total = text + reasoning + tool
  const base = `text ${text} + reasoning ${reasoning} + tool ${tool} chars selected (≈${estTokens(total)} tokens, estimate)`
  return types.has("reasoning")
    ? `${base} — reasoning savings are provider-dependent`
    : base
}

/**
 * Estimaciones honestas (D11): saving por turno = lo que deja de pagarse;
 * reprice one-time = lo que vuelve a pagar el cache tras invalidar desde el
 * primer mensaje; break-even con max(1,…) para no dividir por cero.
 * `charsAfterStretch` lo computa el flow (Σ chars visibles post-stretch).
 */
export function buildEstimates(
  beforeChars: number,
  afterChars: number,
  charsAfterStretch: number,
  firstMsgID: string,
): DistillEstimates {
  const savingPerTurnTokens = estTokens(beforeChars - afterChars)
  const oneTimeRepriceTokens = estTokens(afterChars + charsAfterStretch)
  const estBreakEvenTurns = Math.ceil(
    oneTimeRepriceTokens / Math.max(1, savingPerTurnTokens),
  )
  return { cacheInvalidationFrom: firstMsgID, oneTimeRepriceTokens, savingPerTurnTokens, estBreakEvenTurns }
}

/** DialogConfirm de 5 líneas exactas (D1): rango, breakdown, contexto, cache, trace. */
export function buildConfirmMessage(
  range: ConfirmRange,
  nMessages: number,
  typeBreakdown: string,
  beforeChars: number,
  afterChars: number,
  estimates: DistillEstimates,
): string {
  return [
    `Distill ${nMessages} assistant messages (${range.firstID}..${range.lastID})?`,
    typeBreakdown,
    `Context: ${beforeChars} chars → ${afterChars} chars (≈${estimates.savingPerTurnTokens} tokens saved, estimate)`,
    `Prompt cache: one-time reprice ≈${estimates.oneTimeRepriceTokens} tokens; breaks even after ≈${estimates.estBreakEvenTurns} turns (estimate)`,
    "Originals are preserved in a local trace; /distill-restore undoes this.",
  ].join("\n")
}

/** DialogConfirm del restore: fecha ISO del trace + cantidad de mensajes. */
export function buildRestoreConfirmMessage(trace: RestoreTraceInfo): string {
  const date = new Date(trace.createdAt).toISOString()
  return [
    `Restore distillation from ${date} (${trace.stretch.length} messages)?`,
    "This rewrites the session back to the original content from the trace.",
  ].join("\n")
}

/** Toast de REPORT: chars medibles + tokens siempre calificados (D11). */
export function buildReportToast(
  nMessages: number,
  beforeChars: number,
  afterChars: number,
): string {
  const saved = beforeChars - afterChars
  return `Distilled ${nMessages} messages — ~${saved} chars saved (≈${estTokens(saved)} tokens, estimate)`
}

// --- Mapeo de errores del UPDATE (espejo de mapDeleteError del sibling) ---

/** Resultado discriminado del mapeo de errores del UPDATE. */
export type UpdateErrorKind =
  | "busy"
  | "session-not-found"
  | "unsupported-version"
  | "request-failed"
  | "network"
  | "version-mismatch"

export type UpdateErrorMapping = {
  kind: UpdateErrorKind
  /** Copy en inglés, lista para el toast. */
  message: string
  status?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Forma del `NotFoundError` del SDK: `{ name: "NotFoundError", data: { message } }`. */
function isNotFoundErrorShape(body: unknown): boolean {
  if (!isRecord(body)) return false
  if (body["name"] !== "NotFoundError") return false
  const data = body["data"]
  return isRecord(data) && typeof data["message"] === "string"
}

/** El interceptor del SDK throwea este texto para respuestas `text/html` (C4). */
function mentionsVersionMismatch(text: string): boolean {
  return /text\/html|not supported by this version/i.test(text)
}

function genericUpdateFailure(status: number): UpdateErrorMapping {
  return { kind: "request-failed", message: `Update failed (${status})`, status }
}

/**
 * Mapea el error del UPDATE a un resultado discriminado con copy lista.
 * Cubre los dos carriles (C4): el `throw` del interceptor (siempre un `Error`)
 * y el `result.error` del result-tuple (body parseado + status HTTP).
 */
export function mapUpdateError(error: unknown, status?: number): UpdateErrorMapping {
  // Carril 1: throw del interceptor o de `fetch` (sin result-tuple).
  if (error instanceof Error) {
    if (mentionsVersionMismatch(error.message)) {
      return {
        kind: "version-mismatch",
        message: "This opencode version doesn't support part writes",
        status,
      }
    }
    return { kind: "network", message: "Could not reach opencode server", status }
  }
  // Cuerpo de error en texto plano (no-JSON): solo distingue version-mismatch;
  // el resto lo decide el status más abajo (un string nunca tiene forma NotFoundError).
  if (typeof error === "string") {
    if (mentionsVersionMismatch(error) || /<html/i.test(error)) {
      return {
        kind: "version-mismatch",
        message: "This opencode version doesn't support part writes",
        status,
      }
    }
  }
  // El 409 manda: la sesión está ocupada (protección defensiva; task #5 midió que no hay 409 real).
  if (status === 409) {
    return { kind: "busy", message: "Session was busy — nothing written", status }
  }
  // 404 con forma NotFoundError → la sesión ya no existe.
  if (isNotFoundErrorShape(error) && (status === 404 || status === undefined)) {
    return {
      kind: "session-not-found",
      message: "Session not found — it may have been deleted",
      status,
    }
  }
  // 404 genérico → el endpoint no existe en esta versión (drift, C9).
  if (status === 404) {
    return {
      kind: "unsupported-version",
      message: "This opencode version doesn't support part writes",
      status,
    }
  }
  // 400/401/403/5xx → genérico con status.
  if (status !== undefined) return genericUpdateFailure(status)
  // Sin status ni forma conocida → no hubo respuesta (red caída).
  return { kind: "network", message: "Could not reach opencode server" }
}
