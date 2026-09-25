// Lógica pura de selección de stretch y tipos (diseño §3 + §4).
// Sin dependencias, sin efectos, sin acceso a `api`. Sin importar el SDK.
//
// Convenciones: copy de UI en inglés, comentarios en español rioplatense.

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
    end = messages.length - 1
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
