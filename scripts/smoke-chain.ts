// Smoke de evidencia (one-time, NO gate de regresion — Metis F10):
// cadena de trazas DEC-4 contra el harness aislado: doble-distill solapado +
// restore de traza vieja + re-distill completo sin drift.
//
// Flujo: sesion scratch con 5 turnos (cada uno con tool call real `read` sobre
// un case-file distinto, patron task #17) → T1 = distill real de los
// assistants de los turnos 1..3 → T2 = distill real de los turnos 3..5 con
// input via pristineReconstruct (ASSERT 1: el prompt del destilador contiene
// el PRISTINO del turno 3, no los stubs de T1) → restore de T1 (la traza
// VIEJA) via cadena real (ASSERT 2: read-back turnos 1..3 == pristino pre-T1
// por partHash; lo de T2 ausente en el solape, presente en turnos 4..5) →
// re-distill de los 5 turnos con input via pristineReconstruct (ASSERT 3:
// pristino de nuevo, sin summary-of-summary drift) + execute real.
//
// Uso: PORT=4717 LOG=/tmp/opencode/distill-smoke-18.log scripts/run-smoke.sh scripts/smoke-chain.ts
//
// Seguridad: sesion scratch en /tmp/opencode/, borrada en `finally`.
// Jamas toca :4096 ni sesiones reales. Sin post-distill prompt (finding task
// #17: metadata no-vacia rompe el turno siguiente).
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { mkdirSync, writeFileSync } from "node:fs"
import {
  buildRewritePlan,
  partHash,
  selectedChars,
  simulatePlan,
  snapshotForTrace,
  type PartLike,
  type PartTypeName,
  type TypeFilter,
} from "../src/pure.js"
import {
  buildBudget,
  buildDistillPrompt,
  buildTranscript,
  parseDistillOutput,
  userRequestFor,
} from "../src/distill.js"
import {
  appendPlanned,
  appendStatus,
  buildRestoreOps,
  pristineReconstruct,
  readTraces,
} from "../src/journal.js"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[chain] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const baseDir = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-chain"
const client = createOpencodeClient({ baseUrl })

const MODEL = { providerID: "litellm", modelID: process.env.SMOKE_MODEL ?? "muse-spark-1.3-contributor" }
const DISTILL_MODEL = { providerID: "litellm", modelID: process.env.SMOKE_DISTILL_MODEL ?? MODEL.modelID }
const ALL: TypeFilter = new Set<PartTypeName>(["text", "reasoning", "tool"])

const TURN_TIMEOUT = 240_000

const TURNS = [
  { file: "case-a.txt", keyword: "QUASAR" },
  { file: "case-b.txt", keyword: "NEBULA" },
  { file: "case-c.txt", keyword: "PULSAR" },
  { file: "case-d.txt", keyword: "MAGNETAR" },
  { file: "case-e.txt", keyword: "BLAZAR" },
]

function caseFileContent(keyword: string, seed: string): string {
  const filler = `debug note ${seed}: the sensor array reported nominal values across all channels `.repeat(18)
  return [
    `CASE FILE ${seed}`,
    filler,
    `line of interest: the containment field is ${keyword} under load, sector 7`,
    filler,
    `end of file ${seed}`,
  ].join("\n")
}

function turnPrompt(t: { file: string; keyword: string }): string {
  return (
    `Read the file ${t.file} in the current directory with the read tool. ` +
    `Then reply with the full line that contains the word ${t.keyword} and nothing else.`
  )
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

type Entry = { info: { id: string; role: string; summary?: boolean; time?: { created: number } }; parts: Part[] }

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
      return { ...base, type: "tool", metadata: t.metadata, state: { status: t.state.status, output: t.state.output } }
    }
    if (t.state.status === "error") {
      return { ...base, type: "tool", metadata: t.metadata, state: { status: t.state.status, error: t.state.error } }
    }
    return { ...base, type: "tool", metadata: t.metadata, state: { status: t.state.status } }
  }
  return { ...base, type: p.type }
}

type MessageLikeLocal = {
  id: string
  role: "user" | "assistant"
  time: { created: number }
  summary?: boolean
  parts: readonly PartLike[]
}

function toMessageLikes(entries: Entry[]): MessageLikeLocal[] {
  const out: MessageLikeLocal[] = []
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

function replyTextOf(entries: Entry[]): string {
  const assistants = entries.filter((m) => m.info.role === "assistant")
  const last = assistants[assistants.length - 1]
  return (last?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as TextPart).text)
    .join(" | ")
}

function dumpParts(label: string, parts: readonly Part[]): void {
  console.log(`[chain] ${label}: ${parts.length} partes`)
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

async function loadState(sessionID: string, directory: string): Promise<{
  entries: Entry[]
  messages: MessageLikeLocal[]
  mutableOnly: Map<string, readonly PartLike[]>
  fullByMessage: Map<string, readonly PartLike[]>
  userMessageIDs: Set<string>
}> {
  const entries = await fetchEntries(sessionID, directory)
  const messages = toMessageLikes(entries)
  const fullByMessage = new Map<string, readonly PartLike[]>()
  const mutableOnly = new Map<string, readonly PartLike[]>()
  const userMessageIDs = new Set<string>()
  for (const m of messages) {
    fullByMessage.set(m.id, m.parts)
    mutableOnly.set(
      m.id,
      m.parts.filter((p) => p.type === "text" || p.type === "reasoning" || p.type === "tool"),
    )
    if (m.role === "user") userMessageIDs.add(m.id)
  }
  return { entries, messages, mutableOnly, fullByMessage, userMessageIDs }
}

async function distillScratch(
  scratchDir: string,
  prompt: string,
  stretchIDs: readonly string[],
  budget: number,
  tag: string,
): Promise<{ summary: string; stubs: Record<string, string> }> {
  let raw: string | undefined
  let attempts = 0
  for (let i = 1; i <= 3; i++) {
    attempts = i
    const created = await client.session.create({ directory: scratchDir, title: `smoke-chain-scratch-${tag}-${i}` })
    if (created.error !== undefined || created.data === undefined) {
      throw new Error(`scratch create failed: ${JSON.stringify(created.error)}`)
    }
    const scratchID = created.data.id
    try {
      const res = await withTimeout(
        client.session.prompt({ sessionID: scratchID, directory: scratchDir, model: DISTILL_MODEL, parts: [{ type: "text", text: prompt }] }),
        TURN_TIMEOUT,
        `scratch-${tag}-${i}`,
      )
      if (res.error !== undefined) {
        console.log(`[chain] scratch ${tag} intento ${i}: prompt error ${JSON.stringify(res.error)}`)
        continue
      }
      const sEntries = await fetchEntries(scratchID, scratchDir)
      raw = replyTextOf(sEntries)
      const parsed = parseDistillOutput(raw, stretchIDs, budget)
      console.log(`[chain] scratch ${tag} intento ${i}: rawChars=${raw.length} parse=${parsed.ok ? "ok" : `FAIL ${(parsed as { reason: string }).reason}`}`)
      if (parsed.ok) break
      raw = undefined
    } finally {
      await client.session.delete({ sessionID: scratchID, directory: scratchDir })
    }
  }
  if (raw === undefined) throw new Error(`distiller ${tag} parse fallo tras ${attempts} intentos`)
  const parsed = parseDistillOutput(raw, stretchIDs, budget)
  if (!parsed.ok) throw new Error(`parse final ${tag} fallo: ${(parsed as { reason: string }).reason}`)
  return parsed.distillate
}

async function executePlan(
  sessionID: string,
  directory: string,
  ops: readonly { kind: string; messageID: string; part?: PartLike; partID?: string }[],
  sdkOriginals: ReadonlyMap<string, Part>,
  tag: string,
): Promise<string[]> {
  const created: string[] = []
  for (const op of ops) {
    if (op.kind !== "update" || op.part === undefined) continue
    const like = op.part
    let sdkPart: Part
    if (like.id.startsWith("prt_distill_") || like.id.startsWith("prt_stub_")) {
      sdkPart = {
        id: like.id,
        sessionID,
        messageID: op.messageID,
        type: "text",
        text: like.text ?? "",
        synthetic: true,
        metadata: { ...(like.metadata as Record<string, unknown> | undefined) },
      }
    } else if (like.type === "tool") {
      const orig = sdkOriginals.get(like.id)
      if (orig === undefined || orig.type !== "tool") throw new Error(`${tag}: sin original SDK para tool ${like.id}`)
      const label = like.state?.output ?? "[distilled]"
      if (orig.state.status !== "completed") throw new Error(`${tag}: tool ${like.id} no-completed: ${orig.state.status}`)
      sdkPart = {
        ...orig,
        state: { ...orig.state, output: label },
        metadata: { ...(orig.metadata ?? {}), preview: label },
      }
    } else {
      throw new Error(`${tag}: update inesperado sobre ${like.id} (${like.type})`)
    }
    const r = await client.part.update({ sessionID, messageID: op.messageID, partID: like.id, directory, part: sdkPart })
    if (r.error !== undefined) throw new Error(`${tag} part.update ${like.id} failed: ${JSON.stringify(r.error)}`)
    if (like.id.startsWith("prt_distill_") || like.id.startsWith("prt_stub_")) created.push(like.id)
  }
  for (const op of ops) {
    if (op.kind !== "delete" || op.partID === undefined) continue
    const r = await client.part.delete({ sessionID, messageID: op.messageID, partID: op.partID, directory })
    if (r.error !== undefined) throw new Error(`${tag} part.delete ${op.partID} failed: ${JSON.stringify(r.error)}`)
  }
  console.log(`[chain] ${tag} EXECUTE ok (updates->deletes, creadas=${created.join(",")})`)
  return created
}

async function main(): Promise<void> {
  console.log(`[chain] server=${baseUrl} base=${baseDir} model=${MODEL.providerID}/${MODEL.modelID} distillModel=${DISTILL_MODEL.providerID}/${DISTILL_MODEL.modelID}`)
  const dir = `${baseDir}/chain`
  const scratchDir = `${baseDir}/scratch`
  const journalDir = `${baseDir}/journal`
  mkdirSync(dir, { recursive: true })
  mkdirSync(scratchDir, { recursive: true })
  mkdirSync(journalDir, { recursive: true })
  for (const t of TURNS) {
    writeFileSync(`${dir}/${t.file}`, caseFileContent(t.keyword, t.file))
  }
  let sessionID: string | undefined
  const sdkOriginals = new Map<string, Part>()

  try {
    const created = await client.session.create({ directory: dir, title: "smoke-chain" })
    if (created.error !== undefined || created.data === undefined) {
      throw new Error(`create failed: ${JSON.stringify(created.error)}`)
    }
    sessionID = created.data.id
    console.log(`[chain] session=${sessionID} dir=${dir}`)

    const turnAssistants: string[][] = []
    for (let i = 0; i < TURNS.length; i++) {
      const turn = TURNS[i]
      if (turn === undefined) continue
      const before = new Set((await fetchEntries(sessionID, dir)).filter((e) => e.info.role === "assistant").map((e) => e.info.id))
      const res = await withTimeout(
        client.session.prompt({ sessionID, directory: dir, model: MODEL, parts: [{ type: "text", text: turnPrompt(turn) }] }),
        TURN_TIMEOUT,
        `turn${i + 1}`,
      )
      if (res.error !== undefined) throw new Error(`turn${i + 1} failed: ${JSON.stringify(res.error)}`)
      const after = (await fetchEntries(sessionID, dir)).filter((e) => e.info.role === "assistant").map((e) => e.info.id)
      const added = after.filter((id) => !before.has(id))
      turnAssistants.push(added)
      const entries = await fetchEntries(sessionID, dir)
      const reply = replyTextOf(entries)
      const ok = reply.includes(turn.keyword)
      console.log(`[chain] turn${i + 1} marker ${turn.keyword}: ${ok ? "OK" : "FAIL"} assistants+${added.length} reply=${JSON.stringify(reply.slice(0, 100))}`)
      if (!ok) throw new Error(`turn${i + 1}: el modelo no devolvio ${turn.keyword} (reply=${JSON.stringify(reply.slice(0, 200))})`)
      if (added.length === 0) throw new Error(`turn${i + 1}: no agrego assistants`)
    }

    const t = (i: number): string[] => turnAssistants[i] ?? []
    const idsT1 = [...t(0), ...t(1), ...t(2)]
    const idsT2 = [...t(2), ...t(3), ...t(4)]
    const idsAll = [...t(0), ...t(1), ...t(2), ...t(3), ...t(4)]
    const overlap = t(2)
    console.log(`[chain] T1 stretch (turnos 1..3): ${idsT1.join(",")}`)
    console.log(`[chain] T2 stretch (turnos 3..5): ${idsT2.join(",")} (solape: ${overlap.join(",")})`)

    const st0 = await loadState(sessionID, dir)
    const snapFull = snapshotForTrace({ sessionID, directory: dir, messageIDs: idsAll }, st0.fullByMessage)
    console.log(`[chain] SNAPSHOT pre-T1 originals=${snapFull.originals.length}`)
    for (const h of snapFull.hashes) console.log(`[chain]   hash ${h.partID} -> ${h.hash}`)
    for (const e of st0.entries) {
      if (!idsAll.includes(e.info.id)) continue
      for (const p of e.parts) sdkOriginals.set(p.id, p)
    }

    const snapT1 = snapshotForTrace({ sessionID, directory: dir, messageIDs: idsT1 }, st0.fullByMessage)
    const pristineT1 = snapT1.originals.map((o) => o.part)
    const transcript1 = buildTranscript(pristineT1, idsT1, ALL)
    const req1 = userRequestFor(st0.messages, { sessionID, directory: dir, messageIDs: idsT1 })
    const before1 = selectedChars(pristineT1, ALL)
    const budget1 = buildBudget(before1)
    console.log(`[chain] T1 beforeChars=${before1} budget=${budget1}`)
    const prompt1 = buildDistillPrompt(transcript1, req1, budget1, ALL)
    const d1 = await distillScratch(scratchDir, prompt1, idsT1, budget1, "T1")
    const distillate1 = { ...d1, model: { providerID: MODEL.providerID, modelID: MODEL.modelID } }
    console.log(`[chain] T1 DISTILLATE summaryChars=${distillate1.summary.length} stubs=${JSON.stringify(distillate1.stubs)}`)
    const plan1 = buildRewritePlan(
      { sessionID, directory: dir, messageIDs: idsT1 },
      pristineT1.filter((p) => p.type === "text" || p.type === "reasoning" || p.type === "tool"),
      distillate1,
      ALL,
    )
    const sim1 = simulatePlan(plan1, st0.fullByMessage, { originals: [...snapT1.originals], userMessageIDs: st0.userMessageIDs })
    if (!sim1.ok) throw new Error(`T1 simulate FAIL: ${(sim1 as { invariant: string }).invariant}`)
    console.log("[chain] T1 SIMULATE ok (I1–I8)")
    const createdT1 = await executePlan(sessionID, dir, plan1.ops, sdkOriginals, "T1")
    const ts1 = Date.now()
    const j1 = appendPlanned(journalDir, {
      version: 1, sessionID, createdAt: ts1, stretch: [...idsT1],
      originals: [...snapT1.originals], createdPartIDs: createdT1,
      plan: [...plan1.ops], distillate: distillate1, status: "planned",
    }, ts1)
    if (!j1.ok) throw new Error(`T1 appendPlanned failed: ${j1.message}`)
    const jd1 = appendStatus(journalDir, sessionID, ts1, "done", Date.now())
    if (!jd1.ok) throw new Error(`T1 appendStatus failed: ${jd1.message}`)
    console.log(`[chain] T1 TRACE ${(j1 as { file: string }).file} -> done`)

    const st1 = await loadState(sessionID, dir)
    const traces1 = readTraces(journalDir, sessionID)
    if (!traces1.ok) throw new Error(`readTraces failed: ${traces1.message}`)
    const pris2 = pristineReconstruct(st1.mutableOnly, traces1.traces, idsT2)
    if (!pris2.ok) throw new Error(`T2 pristineReconstruct failed: ${pris2.reason} ${pris2.message}`)
    const pristineParts2 = idsT2.flatMap((id) => pris2.pristine.get(id) ?? [])
    const transcript2 = buildTranscript(pristineParts2, idsT2, ALL)
    const req2 = userRequestFor(st1.messages, { sessionID, directory: dir, messageIDs: idsT2 })
    const before2 = selectedChars(pristineParts2, ALL)
    const budget2 = buildBudget(before2)
    const prompt2 = buildDistillPrompt(transcript2, req2, budget2, ALL)
    console.log(`[chain] --- T2 transcript (input reconstruido, raw) ---`)
    console.log(transcript2)
    console.log(`[chain] --- fin T2 transcript ---`)
    const markerTurn3 = TURNS[2]?.keyword ?? ""
    const a1pristine = prompt2.includes(markerTurn3)
    console.log(`[chain] ASSERT1 prompt-incluye-pristino-turno3(${markerTurn3}): ${a1pristine ? "OK" : "FAIL"}`)
    if (!a1pristine) throw new Error(`ASSERT1 FAIL: el input de T2 no trae el pristino del turno 3 (${markerTurn3} ausente)`)
    let a1clean = true
    for (const mid of overlap) {
      const stub = distillate1.stubs[mid]
      if (stub === undefined || stub === "") continue
      const absent = !prompt2.includes(stub)
      console.log(`[chain] ASSERT1 prompt-excluye-stub-T1(${mid}=${JSON.stringify(stub)}): ${absent ? "OK" : "FAIL"}`)
      if (!absent) a1clean = false
    }
    if (!a1clean) throw new Error("ASSERT1 FAIL: el input de T2 trae stubs de T1 (drift summary-of-summary)")
    console.log("[chain] ASSERT1 OK (input de T2 = pristino, no stub)")

    const d2 = await distillScratch(scratchDir, prompt2, idsT2, budget2, "T2")
    const distillate2 = { ...d2, model: { providerID: MODEL.providerID, modelID: MODEL.modelID } }
    console.log(`[chain] T2 DISTILLATE summaryChars=${distillate2.summary.length} stubs=${JSON.stringify(distillate2.stubs)}`)
    const st1b = await loadState(sessionID, dir)
    const snapT2 = snapshotForTrace({ sessionID, directory: dir, messageIDs: idsT2 }, st1b.fullByMessage)
    const plan2 = buildRewritePlan(
      { sessionID, directory: dir, messageIDs: idsT2 },
      idsT2.flatMap((id) => st1b.mutableOnly.get(id) ?? []),
      distillate2,
      ALL,
    )
    const sim2 = simulatePlan(plan2, st1b.fullByMessage, { originals: [...snapT2.originals], userMessageIDs: st1b.userMessageIDs })
    if (!sim2.ok) throw new Error(`T2 simulate FAIL: ${(sim2 as { invariant: string }).invariant}`)
    console.log("[chain] T2 SIMULATE ok (I1–I8)")
    const createdT2 = await executePlan(sessionID, dir, plan2.ops, sdkOriginals, "T2")
    const ts2 = Date.now()
    const j2 = appendPlanned(journalDir, {
      version: 1, sessionID, createdAt: ts2, stretch: [...idsT2],
      originals: [...snapT2.originals], createdPartIDs: createdT2,
      plan: [...plan2.ops], distillate: distillate2, status: "planned",
    }, ts2)
    if (!j2.ok) throw new Error(`T2 appendPlanned failed: ${j2.message}`)
    const jd2 = appendStatus(journalDir, sessionID, ts2, "done", Date.now())
    if (!jd2.ok) throw new Error(`T2 appendStatus failed: ${jd2.message}`)
    console.log(`[chain] T2 TRACE ${(j2 as { file: string }).file} -> done`)
    const distillateID_T2 = createdT2.find((id) => id.startsWith("prt_distill_"))
    if (distillateID_T2 === undefined) throw new Error("T2 no creo prt_distill_* (inesperado)")

    const st2 = await loadState(sessionID, dir)
    const traces2 = readTraces(journalDir, sessionID)
    if (!traces2.ok) throw new Error(`readTraces failed: ${traces2.message}`)
    const prisR = pristineReconstruct(st2.mutableOnly, traces2.traces, idsT1)
    if (!prisR.ok) throw new Error(`restore pristineReconstruct failed: ${prisR.reason} ${prisR.message}`)
    const opsR = buildRestoreOps(st2.mutableOnly, prisR.pristine, idsT1)
    if (!opsR.ok) throw new Error(`buildRestoreOps failed: ${opsR.reason} ${opsR.message}`)
    console.log(`[chain] RESTORE-T1 ops=${opsR.ops.length}`)
    for (const op of opsR.ops) {
      if (op.kind === "update") {
        const stashed = sdkOriginals.get(op.part.id)
        if (stashed === undefined) throw new Error(`restore sin stash para ${op.part.id}`)
        const r = await client.part.update({ sessionID, messageID: op.messageID, partID: op.part.id, directory: dir, part: stashed })
        if (r.error !== undefined) throw new Error(`restore update ${op.part.id} failed: ${JSON.stringify(r.error)}`)
      } else {
        const r = await client.part.delete({ sessionID, messageID: op.messageID, partID: op.partID, directory: dir })
        if (r.error !== undefined) throw new Error(`restore delete ${op.partID} failed: ${JSON.stringify(r.error)}`)
      }
    }
    const jr = appendStatus(journalDir, sessionID, ts1, "restored", Date.now())
    if (!jr.ok) throw new Error(`T1 appendStatus restored failed: ${jr.message}`)
    console.log("[chain] RESTORE-T1 execute ok + trace T1 -> restored")

    const stR = await loadState(sessionID, dir)
    const restoredByID = new Map<string, Part>()
    for (const e of (await fetchEntries(sessionID, dir))) {
      if (!idsAll.includes(e.info.id)) continue
      dumpParts(`restored ${e.info.id} (${e.info.role})`, e.parts)
      for (const p of e.parts) restoredByID.set(p.id, p)
    }
    let restoreOk = true
    for (const h of snapFull.hashes) {
      const origMsg = snapFull.originals.find((o) => o.part.id === h.partID)?.messageID
      if (origMsg === undefined || !idsT1.includes(origMsg)) continue
      const found = restoredByID.get(h.partID)
      const got = found !== undefined ? partHash(toPartLike(found)) : undefined
      const ok = got === h.hash
      console.log(`[chain] ASSERT2 restore-hash ${h.partID}: ${ok ? "OK" : `FAIL (want ${h.hash}, got ${got})`}`)
      if (!ok) restoreOk = false
    }
    for (const id of createdT1) {
      const gone = !restoredByID.has(id)
      console.log(`[chain] ASSERT2 T1-created-gone ${id}: ${gone ? "OK" : "FAIL"}`)
      if (!gone) restoreOk = false
    }
    for (const mid of overlap) {
      const absent = ![...(stR.fullByMessage.get(mid) ?? [])].some((p) => p.id === distillateID_T2)
      console.log(`[chain] ASSERT2 T2-distillate-ausente-en-solape(${mid}): ${absent ? "OK" : "FAIL"}`)
      if (!absent) restoreOk = false
    }
    for (const mid of [...t(3), ...t(4)]) {
      const stubID = `prt_stub_${mid}`
      const present = (stR.fullByMessage.get(mid) ?? []).some((p) => p.id === stubID)
      console.log(`[chain] ASSERT2 T2-stub-presente(${stubID}): ${present ? "OK" : "FAIL"}`)
      if (!present) restoreOk = false
    }
    if (!restoreOk) throw new Error("ASSERT2 FAIL (ver checks arriba)")
    console.log("[chain] ASSERT2 OK (restore de traza vieja verificado por read-back)")

    const st3 = await loadState(sessionID, dir)
    const traces3 = readTraces(journalDir, sessionID)
    if (!traces3.ok) throw new Error(`readTraces failed: ${traces3.message}`)
    const pris3 = pristineReconstruct(st3.mutableOnly, traces3.traces, idsAll)
    if (!pris3.ok) throw new Error(`T3 pristineReconstruct failed: ${pris3.reason} ${pris3.message}`)
    const pristineParts3 = idsAll.flatMap((id) => pris3.pristine.get(id) ?? [])
    const transcript3 = buildTranscript(pristineParts3, idsAll, ALL)
    const req3 = userRequestFor(st3.messages, { sessionID, directory: dir, messageIDs: idsAll })
    const before3 = selectedChars(pristineParts3, ALL)
    const budget3 = buildBudget(before3)
    const prompt3 = buildDistillPrompt(transcript3, req3, budget3, ALL)
    console.log(`[chain] --- T3 transcript (re-distill completo, raw) ---`)
    console.log(transcript3)
    console.log(`[chain] --- fin T3 transcript ---`)
    let redrillOk = true
    for (const turn of TURNS) {
      const present = prompt3.includes(turn.keyword)
      console.log(`[chain] ASSERT3 prompt-incluye-pristino(${turn.keyword}): ${present ? "OK" : "FAIL"}`)
      if (!present) redrillOk = false
    }
    const priorTexts = [
      distillate1.summary,
      ...Object.values(distillate1.stubs),
      distillate2.summary,
      ...Object.values(distillate2.stubs),
    ]
    for (const txt of priorTexts) {
      if (txt === "") continue
      const absent = !prompt3.includes(txt)
      console.log(`[chain] ASSERT3 prompt-excluye-previo(${JSON.stringify(txt.slice(0, 60))}): ${absent ? "OK" : "FAIL"}`)
      if (!absent) redrillOk = false
    }
    if (!redrillOk) throw new Error("ASSERT3 FAIL: el re-distill no parte de pristino (drift)")
    console.log("[chain] ASSERT3 OK (re-distill parte de pristino, sin drift)")

    const d3 = await distillScratch(scratchDir, prompt3, idsAll, budget3, "T3")
    const distillate3 = { ...d3, model: { providerID: MODEL.providerID, modelID: MODEL.modelID } }
    console.log(`[chain] T3 DISTILLATE summaryChars=${distillate3.summary.length} stubs=${JSON.stringify(distillate3.stubs)}`)
    const st3b = await loadState(sessionID, dir)
    const snapT3 = snapshotForTrace({ sessionID, directory: dir, messageIDs: idsAll }, st3b.fullByMessage)
    const plan3 = buildRewritePlan(
      { sessionID, directory: dir, messageIDs: idsAll },
      idsAll.flatMap((id) => st3b.mutableOnly.get(id) ?? []),
      distillate3,
      ALL,
    )
    const sim3 = simulatePlan(plan3, st3b.fullByMessage, { originals: [...snapT3.originals], userMessageIDs: st3b.userMessageIDs })
    if (!sim3.ok) throw new Error(`T3 simulate FAIL: ${(sim3 as { invariant: string }).invariant}`)
    console.log("[chain] T3 SIMULATE ok (I1–I8)")
    const createdT3 = await executePlan(sessionID, dir, plan3.ops, sdkOriginals, "T3")
    const ts3 = Date.now()
    const j3 = appendPlanned(journalDir, {
      version: 1, sessionID, createdAt: ts3, stretch: [...idsAll],
      originals: [...snapT3.originals], createdPartIDs: createdT3,
      plan: [...plan3.ops], distillate: distillate3, status: "planned",
    }, ts3)
    if (!j3.ok) throw new Error(`T3 appendPlanned failed: ${j3.message}`)
    const jd3 = appendStatus(journalDir, sessionID, ts3, "done", Date.now())
    if (!jd3.ok) throw new Error(`T3 appendStatus failed: ${jd3.message}`)
    console.log(`[chain] T3 TRACE ${(j3 as { file: string }).file} -> done`)
    for (const e of (await fetchEntries(sessionID, dir))) {
      if (!idsAll.includes(e.info.id)) continue
      dumpParts(`final ${e.info.id} (${e.info.role})`, e.parts)
    }

    console.log("[chain] ALL CHECKS DONE")
  } finally {
    if (sessionID !== undefined) {
      try {
        const del = await client.session.delete({ sessionID, directory: dir })
        console.log(`[chain] cleanup ${sessionID} status=${del.response?.status}`)
      } catch (e) {
        console.log(`[chain] cleanup ${sessionID} error: ${String(e)}`)
      }
    }
  }
}

main().catch((e) => {
  console.error("[chain] fatal", e)
  process.exit(1)
})
