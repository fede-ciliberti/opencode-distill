// Smoke de evidencia (one-time, NO gate de regresión — Metis F10):
// destilación end-to-end real contra el harness aislado.
// Flujo: twin sessions (A control / B destilada) con prompts idénticos →
// select → snapshot → scratch prompt real → plan → simulate → EXECUTE con
// part.update/part.delete → VERIFY por read-back (I1/I2/I3) → MEDICIÓN de
// tokens (Δ A−B vs estTokens) → RESTORE → read-back == snapshot (partHash).
//
// Uso: PORT=4716 LOG=/tmp/opencode/distill-smoke-17.log scripts/run-smoke.sh scripts/smoke-distill-e2e.ts
//
// Seguridad: sesiones scratch en /tmp/opencode/, borradas en `finally`.
// Jamás toca :4096 ni sesiones reales. Sin `variant:"high"`.
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { mkdirSync, writeFileSync } from "node:fs"
import {
  buildRewritePlan,
  partHash,
  selectedChars,
  simulatePlan,
  selectStretch,
  snapshotForTrace,
  type PartLike,
  type PartTypeName,
  type TypeFilter,
} from "../src/pure.js"
import {
  buildBudget,
  buildDistillPrompt,
  buildTranscript,
  estTokens,
  parseDistillOutput,
  userRequestFor,
} from "../src/distill.js"
import { appendPlanned, buildRestoreOps, pristineReconstruct, readTraces } from "../src/journal.js"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[smoke] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const baseDir = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-distill-e2e"
const client = createOpencodeClient({ baseUrl })

// El default deepseek-v4-flash NO responde bajo --pure en este entorno;
// modelo explícito que sí responde (learnings tasks #4/#5).
const MODEL = { providerID: "litellm", modelID: process.env.SMOKE_MODEL ?? "muse-spark-1.3-contributor" }
const DISTILL_MODEL = { providerID: "litellm", modelID: process.env.SMOKE_DISTILL_MODEL ?? MODEL.modelID }
const ALL: TypeFilter = new Set<PartTypeName>(["text", "reasoning", "tool"])

const TURN_TIMEOUT = 240_000

// Tres turnos que fuerzan tool call real (read de un archivo con contenido
// largo → masa > MIN_STRETCH_CHARS en cada turno del assistant).
const TURNS = [
  {
    file: "case-a.txt",
    keyword: "FLAMMABLE",
    prompt:
      "Read the file case-a.txt in the current directory with the read tool. " +
      "Then reply with the full line that contains the word FLAMMABLE and nothing else.",
  },
  {
    file: "case-b.txt",
    keyword: "MAGNETIC",
    prompt:
      "Read the file case-b.txt in the current directory with the read tool. " +
      "Then reply with the full line that contains the word MAGNETIC and nothing else.",
  },
  {
    file: "case-c.txt",
    keyword: "VOLCANIC",
    prompt:
      "Read the file case-c.txt in the current directory with the read tool. " +
      "Then reply with the full line that contains the word VOLCANIC and nothing else.",
  },
]
const COMPARE_TURN = "Reply with the single word OK."

function caseFileContent(keyword: string, seed: string): string {
  const filler = `debug note ${seed}: the sensor array reported nominal values across all channels `.repeat(18)
  return [
    `CASE FILE ${seed}`,
    filler,
    `line of interest: the containment field is ${keyword} under load, evacuate sector 7`,
    filler,
    `end of file ${seed}`,
  ].join("\n")
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

type Entry = { info: { id: string; role: string; summary?: boolean; time?: { created: number } }; parts: Part[] }

// SDK Part → PartLike sin casts: extracción campo por campo con narrowing.
function toPartLike(p: Part): PartLike {
  const base = { id: p.id, sessionID: p.sessionID, messageID: p.messageID }
  if (p.type === "text") {
    return { ...base, type: "text", text: p.text, synthetic: p.synthetic, metadata: p.metadata }
  }
  if (p.type === "reasoning") {
    return { ...base, type: "reasoning", text: p.text, metadata: p.metadata }
  }
  if (p.type === "tool") {
    const t = p as ToolPart
    if (t.state.status === "completed") {
      return {
        ...base,
        type: "tool",
        metadata: t.metadata,
        state: { status: t.state.status, output: t.state.output },
      }
    }
    if (t.state.status === "error") {
      return {
        ...base,
        type: "tool",
        metadata: t.metadata,
        state: { status: t.state.status, error: t.state.error },
      }
    }
    return { ...base, type: "tool", metadata: t.metadata, state: { status: t.state.status } }
  }
  return { ...base, type: p.type }
}

function toMessageLikes(entries: Entry[]): Array<{
  id: string
  role: "user" | "assistant"
  time: { created: number }
  summary?: boolean
  parts: readonly PartLike[]
}> {
  const out: Array<{
    id: string
    role: "user" | "assistant"
    time: { created: number }
    summary?: boolean
    parts: readonly PartLike[]
  }> = []
  for (const e of entries) {
    if (e.info.role !== "user" && e.info.role !== "assistant") continue
    out.push({
      id: e.info.id,
      role: e.info.role,
      time: { created: e.info.time?.created ?? 0 },
      summary: e.info.role === "assistant" ? e.info.summary : undefined,
      parts: e.parts.map(toPartLike),
    })
  }
  return out
}

async function fetchEntries(sessionID: string, directory: string): Promise<Entry[]> {
  const r = await client.session.messages({ sessionID, directory })
  return ((r.data ?? []) as Entry[]).slice().sort((a, b) => a.info.id.localeCompare(b.info.id))
}

function inputTokensOf(entries: Entry[]): number | undefined {
  const assistants = entries.filter((m) => m.info.role === "assistant")
  const last = assistants[assistants.length - 1]
  const sf = last?.parts.find((p) => p.type === "step-finish")
  if (sf !== undefined && sf.type === "step-finish") return sf.tokens.input
  return undefined
}

function replyTextOf(entries: Entry[]): string {
  const assistants = entries.filter((m) => m.info.role === "assistant")
  const last = assistants[assistants.length - 1]
  return (last?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as TextPart).text)
    .join(" | ")
}

function dumpParts(label: string, parts: readonly Part[]): void {
  console.log(`[e2e] ${label}: ${parts.length} partes`)
  for (const p of parts) {
    if (p.type === "text") {
      const t = p as TextPart
      console.log(
        `    text ${p.id} synthetic=${t.synthetic ?? false} meta=${JSON.stringify(t.metadata ?? null)} text=${JSON.stringify(t.text.slice(0, 120))}`,
      )
    } else if (p.type === "reasoning") {
      console.log(`    reasoning ${p.id} text=${JSON.stringify(p.text.slice(0, 80))}`)
    } else if (p.type === "tool") {
      const t = p as ToolPart
      const st = t.state
      const out = st.status === "completed" ? st.output.slice(0, 80) : (st.status === "error" ? st.error : st.status)
      console.log(
        `    tool ${p.id} tool=${t.tool} status=${st.status} meta=${JSON.stringify(t.metadata ?? null)} output=${JSON.stringify(out)}`,
      )
    } else {
      console.log(`    ${p.type} ${p.id}`)
    }
  }
}

// Construye una twin: sesión scratch + 3 turnos idénticos con tool calls reales.
async function buildTwin(directory: string, label: string): Promise<string> {
  mkdirSync(directory, { recursive: true })
  for (const t of TURNS) {
    writeFileSync(`${directory}/${t.file}`, caseFileContent(t.keyword, t.file))
  }
  const created = await client.session.create({ directory, title: `smoke-e2e-${label}` })
  if (created.error !== undefined || created.data === undefined) {
    throw new Error(`create ${label} failed: ${JSON.stringify(created.error)}`)
  }
  const sessionID = created.data.id
  console.log(`[e2e] twin ${label}: session=${sessionID} dir=${directory}`)
  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i]
    if (turn === undefined) continue
    const res = await withTimeout(
      client.session.prompt({ sessionID, directory, model: MODEL, parts: [{ type: "text", text: turn.prompt }] }),
      TURN_TIMEOUT,
      `${label}-turn${i + 1}`,
    )
    if (res.error !== undefined) throw new Error(`${label} turn${i + 1} failed: ${JSON.stringify(res.error)}`)
    const entries = await fetchEntries(sessionID, directory)
    console.log(`[e2e] twin ${label} turn${i + 1} reply: ${JSON.stringify(replyTextOf(entries).slice(0, 120))}`)
  }
  return sessionID
}

async function comparisonTurn(sessionID: string, directory: string, label: string): Promise<number> {
  const res = await withTimeout(
    client.session.prompt({ sessionID, directory, model: MODEL, parts: [{ type: "text", text: COMPARE_TURN }] }),
    TURN_TIMEOUT,
    `${label}-compare`,
  )
  if (res.error !== undefined) throw new Error(`${label} compare failed: ${JSON.stringify(res.error)}`)
  console.log(`[e2e] twin ${label} prompt res.data: ${JSON.stringify(res.data).slice(0, 300)}`)
  // El turno destilado puede tardar en persistir partes: reintentar lectura hasta 60 s.
  for (let i = 0; i < 12; i++) {
    const entries = await fetchEntries(sessionID, directory)
    const assistants = entries.filter((m) => m.info.role === "assistant")
    const last = assistants[assistants.length - 1]
    const nParts = last?.parts.length ?? -1
    const errField = (last?.info as { error?: unknown }).error
    if (nParts > 0) break
    console.log(`[e2e] twin ${label} compare: assistant vacío (intento ${i + 1}), error=${JSON.stringify(errField)?.slice(0, 200)} — espero 5 s`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  const entries = await fetchEntries(sessionID, directory)
  // Diagnóstico: todos los step-finish de la sesión (crecimiento del contexto por turno).
  const allSf = entries.flatMap((e) =>
    e.parts.filter((p) => p.type === "step-finish").map((p) => `${e.info.id}:${(p as { tokens: { input: number } }).tokens.input}`),
  )
  console.log(`[e2e] twin ${label} step-finish inputs: ${allSf.join(" ")}`)
  const tokens = inputTokensOf(entries)
  console.log(`[e2e] twin ${label} compare reply: ${JSON.stringify(replyTextOf(entries))} inputTokens=${tokens}`)
  if (tokens === undefined) {
    for (const e of entries.slice(-2)) dumpParts(`compare-dbg ${e.info.id} (${e.info.role})`, e.parts)
    throw new Error(`${label} compare: sin step-finish.tokens.input`)
  }
  return tokens
}

async function main(): Promise<void> {
  console.log(`[e2e] server=${baseUrl} base=${baseDir} model=${MODEL.providerID}/${MODEL.modelID} distillModel=${DISTILL_MODEL.providerID}/${DISTILL_MODEL.modelID}`)
  const dirA = `${baseDir}/twin-a`
  const dirB = `${baseDir}/twin-b`
  const scratchDir = `${baseDir}/scratch`
  const journalDir = `${baseDir}/journal`
  mkdirSync(scratchDir, { recursive: true })
  mkdirSync(journalDir, { recursive: true })
  let sessionA: string | undefined
  let sessionB: string | undefined
  // Stash de partes SDK originales (pre-distill) para el restore verbatim.
  const sdkOriginals = new Map<string, Part>()

  try {
    // ---- Twin A (control, sin destilar) ----
    sessionA = await buildTwin(dirA, "A")
    const tokensA = await comparisonTurn(sessionA, dirA, "A")

    // ---- Twin B (a destilar) ----
    sessionB = await buildTwin(dirB, "B")

    // ---- (3a) SELECT con código real ----
    let entriesB = await fetchEntries(sessionB, dirB)
    const messages = toMessageLikes(entriesB)
    const sel = selectStretch(messages, { kind: "current-turn" }, undefined, ALL)
    if (!sel.ok) throw new Error(`selectStretch failed: ${sel.kind} ${sel.message}`)
    const messageIDs = [...sel.messageIDs]
    console.log(`[e2e] SELECT current-turn → ${messageIDs.length} mensajes: ${messageIDs.join(",")}`)

    const partsByMessage = new Map<string, readonly PartLike[]>()
    for (const m of messages) partsByMessage.set(m.id, m.parts)
    const userMessageIDs = new Set<string>()
    for (const m of messages) if (m.role === "user") userMessageIDs.add(m.id)

    // ---- (3b) SNAPSHOT con código real ----
    const stretch = { sessionID: sessionB, directory: dirB, messageIDs }
    const snapshot = snapshotForTrace(stretch, partsByMessage)
    console.log(`[e2e] SNAPSHOT originals=${snapshot.originals.length} hashes=${snapshot.hashes.length}`)
    for (const h of snapshot.hashes) console.log(`[e2e]   hash ${h.partID} → ${h.hash}`)

    const stretchParts = messageIDs.flatMap((id) => partsByMessage.get(id) ?? [])
    const beforeChars = selectedChars(stretchParts, ALL)
    console.log(`[e2e] beforeChars=${beforeChars} budget=${buildBudget(beforeChars)}`)

    // Stash SDK pre-distill para restore verbatim (incluye callID/tool de las tools).
    for (const e of entriesB) {
      if (!messageIDs.includes(e.info.id)) continue
      for (const p of e.parts) sdkOriginals.set(p.id, p)
    }

    // ---- (3c) SCRATCH PROMPT REAL (hasta 3 intentos, no-determinismo documentado) ----
    const pristineParts = snapshot.originals.map((o) => o.part)
    const transcript = buildTranscript(pristineParts, messageIDs, ALL)
    const userRequest = userRequestFor(messages, stretch)
    const budget = buildBudget(beforeChars)
    const prompt = buildDistillPrompt(transcript, userRequest, budget, ALL)
    console.log(`[e2e] transcript chars=${transcript.length} userRequest=${JSON.stringify(userRequest.slice(0, 80))}`)

    let raw: string | undefined
    let attempts = 0
    for (let i = 1; i <= 3; i++) {
      attempts = i
      const created = await client.session.create({ directory: scratchDir, title: `smoke-e2e-scratch-${i}` })
      if (created.error !== undefined || created.data === undefined) {
        throw new Error(`scratch create failed: ${JSON.stringify(created.error)}`)
      }
      const scratchID = created.data.id
      try {
        const res = await withTimeout(
          client.session.prompt({ sessionID: scratchID, directory: scratchDir, model: DISTILL_MODEL, parts: [{ type: "text", text: prompt }] }),
          TURN_TIMEOUT,
          `scratch-${i}`,
        )
        if (res.error !== undefined) {
          console.log(`[e2e] scratch intento ${i}: prompt error ${JSON.stringify(res.error)}`)
          continue
        }
        const sEntries = await fetchEntries(scratchID, scratchDir)
        raw = replyTextOf(sEntries)
        const parsed = parseDistillOutput(raw, messageIDs, budget)
        console.log(`[e2e] scratch intento ${i}: rawChars=${raw.length} parse=${parsed.ok ? "ok" : `FAIL ${(parsed as { reason: string }).reason}`}`)
        if (parsed.ok) break
        raw = undefined
      } finally {
        await client.session.delete({ sessionID: scratchID, directory: scratchDir })
      }
    }
    if (raw === undefined) throw new Error(`distiller parse falló tras ${attempts} intentos`)
    const parsed = parseDistillOutput(raw, messageIDs, budget)
    if (!parsed.ok) throw new Error(`parse final falló: ${(parsed as { reason: string }).reason}`)
    const distillate = { ...parsed.distillate, model: { providerID: MODEL.providerID, modelID: MODEL.modelID } }
    console.log(`[e2e] DISTILLATE summaryChars=${distillate.summary.length} stubs=${JSON.stringify(distillate.stubs)}`)

    // ---- (3d) PLAN + SIMULATE con código real ----
    const mutableParts = stretchParts.filter((p) => p.type === "text" || p.type === "reasoning" || p.type === "tool")
    const plan = buildRewritePlan(stretch, mutableParts, distillate, ALL)
    console.log(
      `[e2e] PLAN ops=${plan.ops.length} before=${plan.mass.beforeChars} after=${plan.mass.afterChars} breakEven=${plan.mass.estBreakEvenTurns}`,
    )
    for (const op of plan.ops) {
      console.log(`[e2e]   op ${op.kind} ${op.kind === "update" ? `${op.messageID}/${op.part.id}` : `${op.messageID}/${op.partID}`}`)
    }
    const sim = simulatePlan(plan, partsByMessage, { originals: [...snapshot.originals], userMessageIDs })
    if (!sim.ok) {
      throw new Error(`simulatePlan FAIL: ${(sim as { invariant: string; message?: string }).invariant} ${(sim as { message?: string }).message ?? ""}`)
    }
    console.log("[e2e] SIMULATE ok (I1–I8)")

    // ---- Trace real en journal temporal (cadena DEC-4 para el restore) ----
    const ts = Date.now()
    const createdPartIDs = plan.ops
      .filter((op) => op.kind === "update")
      .map((op) => (op as { kind: "update"; part: PartLike }).part.id)
      .filter((id) => id.startsWith("prt_distill_") || id.startsWith("prt_stub_"))
    const plannedRes = appendPlanned(journalDir, {
      version: 1,
      sessionID: sessionB,
      createdAt: ts,
      stretch: [...messageIDs],
      originals: [...snapshot.originals],
      createdPartIDs,
      plan: [...plan.ops],
      distillate,
      status: "planned",
    }, ts)
    if (!plannedRes.ok) throw new Error(`appendPlanned failed: ${plannedRes.message}`)
    console.log(`[e2e] TRACE ${(plannedRes as { file: string }).file}`)

    // ---- (3e) EXECUTE manual contra el client ----
    for (const op of plan.ops) {
      if (op.kind !== "update") continue
      const like = op.part
      let sdkPart: Part
      if (like.id.startsWith("prt_distill_") || like.id.startsWith("prt_stub_")) {
        sdkPart = {
          id: like.id,
          sessionID: sessionB,
          messageID: op.messageID,
          type: "text",
          text: like.text ?? "",
          synthetic: true,
          metadata: { ...(like.metadata as Record<string, unknown> | undefined) },
        }
      } else if (like.type === "tool") {
        const orig = sdkOriginals.get(like.id)
        if (orig === undefined || orig.type !== "tool") throw new Error(`sin original SDK para tool ${like.id}`)
        const label = like.state?.output ?? "[distilled]"
        if (orig.state.status !== "completed") throw new Error(`tool ${like.id} no-completed: ${orig.state.status}`)
        sdkPart = {
          ...orig,
          state: { ...orig.state, output: label },
          metadata: { ...(orig.metadata ?? {}), preview: label },
        }
      } else {
        throw new Error(`update inesperado sobre ${like.id} (${like.type})`)
      }
      const r = await client.part.update({ sessionID: sessionB, messageID: op.messageID, partID: like.id, directory: dirB, part: sdkPart })
      if (r.error !== undefined) throw new Error(`part.update ${like.id} failed: ${JSON.stringify(r.error)}`)
    }
    for (const op of plan.ops) {
      if (op.kind !== "delete") continue
      const r = await client.part.delete({ sessionID: sessionB, messageID: op.messageID, partID: op.partID, directory: dirB })
      if (r.error !== undefined) throw new Error(`part.delete ${op.partID} failed: ${JSON.stringify(r.error)}`)
    }
    console.log("[e2e] EXECUTE ok (updates→deletes)")

    // ---- (3f) VERIFY por read-back ----
    entriesB = await fetchEntries(sessionB, dirB)
    let verifyOk = true
    for (const e of entriesB) {
      if (!messageIDs.includes(e.info.id)) continue
      dumpParts(`read-back ${e.info.id} (${e.info.role})`, e.parts)
      // I1: ≥1 text no vacío.
      const hasText = e.parts.some((p) => p.type === "text" && (p as TextPart).text !== "")
      console.log(`[e2e] CHECK I1 ${e.info.id}: ${hasText ? "OK" : "FAIL"}`)
      if (!hasText) verifyOk = false
    }
    // I2: destilado presente con metadata.
    const firstMsg = entriesB.find((e) => e.info.id === messageIDs[0])
    const distPart = firstMsg?.parts.find((p) => p.id.startsWith("prt_distill_"))
    const i2ok =
      distPart !== undefined &&
      distPart.type === "text" &&
      (distPart as TextPart).text !== "" &&
      (distPart as TextPart).synthetic === true &&
      ((distPart as TextPart).metadata as Record<string, unknown> | undefined)?.["distilled"] === true
    console.log(`[e2e] CHECK I2 distillate presente con metadata: ${i2ok ? "OK" : "FAIL"} (${distPart?.id ?? "ausente"})`)
    if (!i2ok) verifyOk = false
    // I3: tool outputs stubeados con preview en consonancia.
    for (const e of entriesB) {
      if (!messageIDs.includes(e.info.id)) continue
      for (const p of e.parts) {
        if (p.type !== "tool") continue
        const t = p as ToolPart
        const out = t.state.status === "completed" ? t.state.output : undefined
        const preview = (t.metadata as Record<string, unknown> | undefined)?.["preview"]
        const stubbed = out !== undefined && out.startsWith("[distilled]") && preview === out
        const untouched = out !== undefined && !out.startsWith("[distilled]")
        console.log(`[e2e] CHECK I3 tool ${p.id}: ${stubbed ? "OK-stubbed" : untouched ? "OK-untouched" : "FAIL"} output=${JSON.stringify((out ?? "").slice(0, 60))}`)
        if (!stubbed && !untouched) verifyOk = false
      }
    }
    if (!verifyOk) throw new Error("VERIFY read-back FAIL (ver checks arriba)")
    console.log("[e2e] VERIFY ok (I1/I2/I3 por read-back)")

    // ---- (4) MEDICIÓN: turno de comparación en ambas twins ----
    // Instrumento: step-finish.tokens.input del ÚLTIMO turno pre-comparación
    // (patrón smoke-reasoning-tokens: el input del turno N+1 refleja el
    // contexto con el tramo destilado). El prompt de comparación se intenta
    // igual para documentar el comportamiento, pero el Δ se deriva de los
    // step-finish ya persistidos (el provider puede rechazar el turno
    // post-distill: "messages do not match ModelMessage[] schema").
    const tokensBpre = inputTokensOf(entriesB)
    if (tokensBpre === undefined) throw new Error("B pre-compare: sin step-finish.tokens.input")
    console.log(`[e2e] twin B pre-compare inputTokens=${tokensBpre}`)
    const nBefore = (await fetchEntries(sessionB, dirB)).length
    let compareNote = "compare-turn-ok"
    try {
      await comparisonTurn(sessionB, dirB, "B")
    } catch (e) {
      compareNote = `compare-turn-failed-documented: ${e instanceof Error ? e.message : String(e)}`
      console.log(`[e2e] B compare: ${compareNote}`)
    }
    const entriesBpost = await fetchEntries(sessionB, dirB)
    const tokensBpost = inputTokensOf(entriesBpost)
    const grew = entriesBpost.length > nBefore && tokensBpost !== tokensBpre
    console.log(`[e2e] twin B post inputTokens=${tokensBpost} grew=${grew}`)
    const tokensB = grew && tokensBpost !== undefined ? tokensBpost : undefined
    if (tokensB === undefined) {
      console.log(`[e2e] CHECK measurement: NO-COMPARABLE como finding (provider rechazó el turno post-distill; Δ A−B no medible en este entorno; tokensA=${tokensA} tokensBpre=${tokensBpre} ahorroChars=${beforeChars - plan.mass.afterChars} estTokens=${estTokens(beforeChars - plan.mass.afterChars)})`)
    } else {
      const delta = tokensA - tokensB
      const est = estTokens(beforeChars - plan.mass.afterChars)
      console.log(`[e2e] MEASURE tokensA(control)=${tokensA} tokensB(distilled)=${tokensB} Δ=${delta} estTokens(ahorro)=${est}`)
      console.log("[e2e] CAVEAT: el Δ incluye el mensaje de comparación + ruido del provider; es evidencia, no gate.")
      const inRange = delta > 0 && delta >= 0.5 * est && delta <= 1.5 * est
      if (delta <= 0) {
        console.log(`[e2e] CHECK measurement: OUT-OF-RANGE como finding (Δ=${delta} ≤ 0, crudo documentado, no aborta)`)
      } else if (!inRange) {
        console.log(`[e2e] CHECK measurement: OUT-OF-RANGE como finding (Δ=${delta} fuera de [${0.5 * est},${1.5 * est}], crudo documentado, no aborta)`)
      } else {
        console.log(`[e2e] CHECK measurement: OK (Δ=${delta} dentro de [${0.5 * est},${1.5 * est}])`)
      }
    }

    // ---- (5) RESTORE: cadena real journal → pristine → ops → execute ----
    const tracesRes = readTraces(journalDir, sessionB)
    if (!tracesRes.ok) throw new Error(`readTraces failed: ${tracesRes.message}`)
    const afterEntries = await fetchEntries(sessionB, dirB)
    const afterLikes = toMessageLikes(afterEntries)
    const mutableOnly = new Map<string, readonly PartLike[]>()
    for (const m of afterLikes) {
      mutableOnly.set(
        m.id,
        m.parts.filter((p) => p.type === "text" || p.type === "reasoning" || p.type === "tool"),
      )
    }
    const currentMap = mutableOnly
    const prisRes = pristineReconstruct(currentMap, tracesRes.traces, messageIDs)
    if (!prisRes.ok) throw new Error(`pristineReconstruct failed: ${prisRes.reason} ${prisRes.message}`)
    const opsRes = buildRestoreOps(currentMap, prisRes.pristine, messageIDs)
    if (!opsRes.ok) throw new Error(`buildRestoreOps failed: ${opsRes.reason} ${opsRes.message}`)
    console.log(`[e2e] RESTORE ops=${opsRes.ops.length}`)
    for (const op of opsRes.ops) {
      if (op.kind === "update") {
        const stashed = sdkOriginals.get(op.part.id)
        if (stashed === undefined) throw new Error(`restore sin stash para ${op.part.id}`)
        const r = await client.part.update({ sessionID: sessionB, messageID: op.messageID, partID: op.part.id, directory: dirB, part: stashed })
        if (r.error !== undefined) throw new Error(`restore update ${op.part.id} failed: ${JSON.stringify(r.error)}`)
      } else {
        const r = await client.part.delete({ sessionID: sessionB, messageID: op.messageID, partID: op.partID, directory: dirB })
        if (r.error !== undefined) throw new Error(`restore delete ${op.partID} failed: ${JSON.stringify(r.error)}`)
      }
    }
    const restoredEntries = await fetchEntries(sessionB, dirB)
    const restoredByID = new Map<string, Part>()
    for (const e of restoredEntries) {
      if (!messageIDs.includes(e.info.id)) continue
      dumpParts(`restored ${e.info.id}`, e.parts)
      for (const p of e.parts) restoredByID.set(p.id, p)
    }
    let restoreOk = true
    for (const h of snapshot.hashes) {
      const found = restoredByID.get(h.partID)
      const got = found !== undefined ? partHash(toPartLike(found)) : undefined
      const ok = got === h.hash
      console.log(`[e2e] CHECK restore ${h.partID}: ${ok ? "OK" : `FAIL (want ${h.hash}, got ${got})`}`)
      if (!ok) restoreOk = false
    }
    for (const id of createdPartIDs) {
      const gone = !restoredByID.has(id)
      console.log(`[e2e] CHECK restore created-gone ${id}: ${gone ? "OK" : "FAIL"}`)
      if (!gone) restoreOk = false
    }
    if (!restoreOk) throw new Error("RESTORE read-back != snapshot (ver checks arriba)")
    console.log("[e2e] RESTORE ok (read-back == snapshot por partHash)")

    console.log("[e2e] ALL CHECKS DONE")
  } finally {
    for (const [sid, dir] of [[sessionA, dirA], [sessionB, dirB]] as Array<[string | undefined, string]>) {
      if (sid === undefined) continue
      try {
        const del = await client.session.delete({ sessionID: sid, directory: dir })
        console.log(`[e2e] cleanup ${sid} status=${del.response?.status}`)
      } catch (e) {
        console.log(`[e2e] cleanup ${sid} error: ${String(e)}`)
      }
    }
  }
}

main().catch((e) => {
  console.error("[e2e] fatal", e)
  process.exit(1)
})
