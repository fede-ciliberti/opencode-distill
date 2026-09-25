// Destilador: prompt, transcript, parser y validador (diseño §5, task #9).
// Sin dependencias, sin efectos, sin acceso a `api`. Sin importar el SDK.
//
// Convenciones: copy de UI en inglés, comentarios en español rioplatense.
import type { Distillate, MessageLike, PartLike, Stretch, TypeFilter } from "./pure.js"

/**
 * Parte con los campos extra que el transcript necesita de las tool parts
 * (nombre de la tool e input). Compatible con `PartLike`: el `state`
 * intersectado acepta `input` además de `output`/`error`.
 */
export type DistillPartLike = PartLike & {
  tool?: string
  state?: { status: string; input?: unknown; output?: string; error?: string }
}

/**
 * Aproximación grosera pero estable: 4 chars ≈ 1 token (estándar inglés;
 * para código suele subestimar un poco, lo que deja el budget del lado
 * conservador). Misma base que usa el budget de §5.2.
 */
export function estTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/** Budget §5.2: `min(1024 tokens, 25% de la masa original)`. */
export function buildBudget(beforeChars: number): number {
  return Math.max(0, Math.min(1024, Math.ceil((beforeChars / 4) * 0.25)))
}

function toolNameOf(part: PartLike): string {
  if ("tool" in part && typeof part.tool === "string" && part.tool !== "") {
    return part.tool
  }
  return "tool"
}

function inputOf(part: PartLike): unknown {
  const state = part.state
  if (state !== undefined && "input" in state && state.input !== undefined) {
    return state.input
  }
  return undefined
}

function outputOf(part: PartLike): string {
  return part.state?.output ?? part.state?.error ?? ""
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input) ?? String(input)
  } catch {
    return String(input)
  }
}

/**
 * Transcript verbatim ya filtrado por tipos (DEC-5): los tipos no
 * seleccionados nunca entran, no se filtran después. Un bloque por mensaje
 * del stretch, numerado 1..n en el orden de `messageIDs`.
 */
export function buildTranscript(
  pristineParts: readonly PartLike[],
  messageIDs: readonly string[],
  types: TypeFilter,
): string {
  const blocks: string[] = []
  messageIDs.forEach((messageID, index) => {
    const n = index + 1
    const lines: string[] = []
    for (const part of pristineParts) {
      if (part.messageID !== messageID) continue
      if (part.type === "text" && types.has("text")) {
        lines.push(part.text ?? "")
      } else if (part.type === "reasoning" && types.has("reasoning")) {
        lines.push(`[reasoning] ${part.text ?? ""}`)
      } else if (part.type === "tool" && types.has("tool")) {
        lines.push(`tool ${toolNameOf(part)}`)
        const input = inputOf(part)
        if (input !== undefined) lines.push(`input: ${stringifyInput(input)}`)
        const output = outputOf(part)
        if (output !== "") lines.push(output)
      }
    }
    if (lines.length === 0) {
      blocks.push(`[${n}] assistant (no selected content)`)
    } else {
      blocks.push(`[${n}] assistant\n${lines.join("\n")}`)
    }
  })
  return blocks.join("\n\n")
}

function scopeLine(types: TypeFilter): string {
  const labels: string[] = []
  if (types.has("text")) labels.push("text")
  if (types.has("reasoning")) labels.push("reasoning")
  if (types.has("tool")) labels.push("tool outputs")
  return `You are distilling only: ${labels.join(", ")}`
}

/**
 * Prompt verbatim de diseño §5.2 (líneas 114-150) con el budget interpolado
 * y una línea de scope. No hardcodea messageIDs: los stubs los numera el
 * destilador (1..n) y el builder de task #7 los mapea a IDs.
 */
export function buildDistillPrompt(
  transcript: string,
  userRequest: string,
  budgetTokens: number,
  types: TypeFilter,
): string {
  return `You are distilling a debugging transcript. You receive: (1) the user request
that started this stretch, (2) a numbered verbatim transcript of the assistant's
work (reasoning, tool calls with inputs/outputs, replies), in order.

Produce a distilled REPLACEMENT that a future assistant turn will read as if it
were the original work.

MUST keep:
- The root cause / final conclusion, if reached.
- Every decision and its rationale.
- Negative results: each hypothesis tested and RULED OUT, with the one-line
  evidence that killed it. Highest-value content.
- Key artifacts: file paths, line numbers, exact error strings, commands that
  worked, discovered values/IDs.
- Open threads (or "none").

MUST drop:
- Exploration with no information value; redundant restatements; raw output
  already captured in a kept item.

Format (strict, no preamble):
<distillate>
## Outcome
<1-3 sentences>
## Ruled out
- <hypothesis>, <evidence>
## Key facts
- <artifact>, <why it matters>
## Open
- <... | none>
</distillate>
<stubs>
<n>: <≤15 words, past tense, what message n did>
</stubs>

Constraints: distillate ≤ ${budgetTokens} tokens. Do not invent facts. If evidence for a
kept claim is missing, keep the claim and mark it (unverified).
${scopeLine(types)}

User request:
${userRequest}

Transcript:
${transcript}`
}

export type ParseDistillResult =
  | { ok: true; distillate: Omit<Distillate, "model"> }
  | { ok: false; reason: string }

/**
 * Extrae los bloques por tags exactos y valida antes de cualquier write:
 * distillate no vacío y ≤ budget; stubs cubren exactamente los n mensajes
 * (cada `n: texto` mapea n→messageID por orden), cada stub no vacío y ≤ 15
 * palabras. Cualquier falla de parse → abort limpio (`ok:false`).
 */
export function parseDistillOutput(
  raw: string,
  stretchMessageIDs: readonly string[],
  budgetTokens: number,
): ParseDistillResult {
  const distillateOpen = "<distillate>"
  const distillateClose = "</distillate>"
  const stubsOpen = "<stubs>"
  const stubsClose = "</stubs>"
  const distillateStart = raw.indexOf(distillateOpen)
  const distillateEnd = raw.indexOf(distillateClose)
  const stubsStart = raw.indexOf(stubsOpen)
  const stubsEnd = raw.indexOf(stubsClose)
  if (distillateStart === -1 || distillateEnd === -1 || stubsStart === -1 || stubsEnd === -1) {
    return { ok: false, reason: "Missing <distillate> or <stubs> tags" }
  }
  if (distillateEnd < distillateStart || stubsEnd < stubsStart) {
    return { ok: false, reason: "Malformed <distillate> or <stubs> tags" }
  }
  const distillate = raw.slice(distillateStart + distillateOpen.length, distillateEnd).trim()
  if (distillate === "") {
    return { ok: false, reason: "Empty distillate" }
  }
  const distillateTokens = estTokens(distillate.length)
  if (distillateTokens > budgetTokens) {
    return {
      ok: false,
      reason: `Distillate exceeds budget (${distillateTokens} > ${budgetTokens} tokens)`,
    }
  }
  const n = stretchMessageIDs.length
  const seen = new Map<number, string>()
  const stubsRaw = raw.slice(stubsStart + stubsOpen.length, stubsEnd)
  for (const line of stubsRaw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    const match = /^(\d+)\s*:\s*(.+)$/.exec(trimmed)
    if (match === null || match[1] === undefined || match[2] === undefined) {
      return { ok: false, reason: `Unparseable stub line: ${trimmed}` }
    }
    const num = Number(match[1])
    const text = match[2].trim()
    if (!Number.isInteger(num) || num < 1 || num > n) {
      return { ok: false, reason: `Stub n out of range: ${match[1]}` }
    }
    if (seen.has(num)) {
      return { ok: false, reason: `Duplicate stub for message ${num}` }
    }
    if (text === "") {
      return { ok: false, reason: `Empty stub for message ${num}` }
    }
    if (text.split(/\s+/).length > 15) {
      return { ok: false, reason: `Stub for message ${num} exceeds 15 words` }
    }
    seen.set(num, text)
  }
  if (seen.size !== n) {
    return { ok: false, reason: `Stubs cover ${seen.size} of ${n} messages` }
  }
  const stubs: Record<string, string> = {}
  for (const [num, text] of seen) {
    const messageID = stretchMessageIDs[num - 1]
    if (messageID !== undefined) stubs[messageID] = text
  }
  return { ok: true, distillate: { summary: distillate, stubs } }
}

/**
 * Texto del último mensaje user ANTES del stretch (el request que arrancó
 * el tramo). Sin user previo → "(none)".
 */
export function userRequestFor(
  messages: readonly MessageLike[],
  stretch: Stretch,
): string {
  const ids = new Set<string>(stretch.messageIDs)
  let first = messages.length
  messages.forEach((message, index) => {
    if (ids.has(message.id) && index < first) first = index
  })
  for (let i = first - 1; i >= 0; i--) {
    const message = messages[i]
    if (message !== undefined && message.role === "user") {
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim()
      return text === "" ? "(none)" : text
    }
  }
  return "(none)"
}
