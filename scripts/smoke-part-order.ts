// Smoke bloqueante Q6: orden de partes tras múltiples upserts.
// Preguntas que responde:
//   1. Upsert de 3 partes NUEVAS con IDs fuera de orden de inserción
//      (zeta, alfa, mm en ese orden) → ¿el read-back ordena por id
//      ascendente, por inserción, o por otra cosa?
//   2. Re-upsert de prt_alfa_probe (solo text) → ¿cambia su posición?
//   3. Orden relativo partes pre-existentes del server vs nuevas.
//
// Uso:  PORT=4713 LOG=/tmp/opencode/distill-smoke-3.log scripts/run-smoke.sh scripts/smoke-part-order.ts
//
// Seguridad: crea una sesión NUEVA en un directorio scratch y la BORRA al final.
// No toca sesiones reales. No imprime secretos.
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part, TextPart } from "@opencode-ai/sdk/v2"
import { mkdirSync } from "node:fs"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[smoke] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const directory = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-part-order"
const client = createOpencodeClient({ baseUrl })

mkdirSync(directory, { recursive: true })

// NOTA: no se invoca al modelo. `prompt({noReply:true})` crea el mensaje
// user server-side al instante y retorna sin correr el agente — suficiente
// porque el orden de partes es nivel storage (projector), independiente del rol.
// (Un prompt con modelo colgó 240s: litellm no responde bajo --pure.)
const TURN1 = "HELLO-PROBE"

type Entry = { info: { id: string; role: string }; parts: Part[] }

async function allMessages(sessionID: string): Promise<Entry[]> {
  const r = await client.session.messages({ sessionID, directory })
  return (r.data ?? []) as Entry[]
}

function dumpOrdered(label: string, entries: Entry[]): void {
  console.log(`\n[smoke] ${label}: ${entries.length} mensajes`)
  for (const m of entries) {
    console.log(`  msg ${m.info.id} (${m.info.role}) — ${m.parts.length} partes`)
    m.parts.forEach((p, i) => console.log(`    [${i}] id=${p.id} type=${p.type}`))
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

function orderOf(parts: Part[], ids: string[]): string {
  return ids.map((id) => parts.findIndex((p) => p.id === id)).join(",")
}

async function main(): Promise<void> {
  console.log(`[smoke] server=${baseUrl} dir=${directory}`)

  const created = await client.session.create({ directory, title: "smoke-part-order" })
  if (created.error || !created.data) {
    console.error("[smoke] create failed", created.error)
    process.exit(1)
  }
  const sessionID = created.data.id
  console.log(`[smoke] session=${sessionID}`)

  let verdict = "UNDETERMINED"
  try {
    // ---- Turno 1: crear un mensaje con partes server-side, sin invocar al modelo ----
    const res = await withTimeout(
      client.session.prompt({ sessionID, directory, noReply: true, parts: [{ type: "text", text: TURN1 }] }),
      30_000,
      "turn1",
    )
    if (res.error || !res.data) {
      console.error("[smoke] prompt failed", res.error)
      process.exit(1)
    }
    let entries = await allMessages(sessionID)
    dumpOrdered("TURNO 1 (baseline, pre-upsert)", entries)

    const target = entries.find((m) => m.parts.length > 0)
    if (!target) {
      console.error("[smoke] FAIL: no message with parts after turn 1")
      process.exit(1)
    }
    const targetMessageID = target.info.id
    const preExistingIDs = target.parts.map((p) => p.id)
    console.log(`[smoke] target message=${targetMessageID} pre-existing parts=${preExistingIDs.length}`)
    console.log(`[smoke] pre-existing ids: ${JSON.stringify(preExistingIDs)}`)

    const upd = (partID: string, text: string) => {
      const part = { id: partID, sessionID, messageID: targetMessageID, type: "text", text } as Part
      return client.part.update({ sessionID, messageID: targetMessageID, partID, directory, part })
    }

    // ---- Sonda 1: 3 upserts NUEVOS en orden de inserción zeta, alfa, mm ----
    const INSERTION = ["prt_zeta_probe", "prt_alfa_probe", "prt_mm_probe"]
    for (const id of INSERTION) {
      const r = await upd(id, `ORDER-PROBE ${id}`)
      if (r.error || !r.data) {
        console.error(`[smoke] FAIL: upsert ${id} failed`, r.error)
        process.exit(1)
      }
      console.log(`[smoke] upsert ${id}: status=${r.response?.status}`)
    }

    entries = await allMessages(sessionID)
    dumpOrdered("SONDA 1 (tras 3 upserts zeta,alfa,mm)", entries)
    const msg1 = entries.find((m) => m.info.id === targetMessageID)
    if (!msg1) {
      console.error("[smoke] FAIL: target message missing on read-back")
      process.exit(1)
    }
    const probeIDs1 = msg1.parts.map((p) => p.id).filter((id) => id.endsWith("_probe"))
    console.log(`[smoke] probe order read-back: ${JSON.stringify(probeIDs1)}`)
    console.log(`[smoke] probe index positions: zeta=${orderOf(msg1.parts, INSERTION)}`)

    const ASC = [...INSERTION].sort()
    const isAsc = JSON.stringify(probeIDs1) === JSON.stringify(ASC)
    const isInsertion = JSON.stringify(probeIDs1) === JSON.stringify(INSERTION)
    console.log(`[smoke] matches ascending-id=${isAsc} matches insertion-order=${isInsertion}`)

    // ---- Sonda 2: re-upsert prt_alfa_probe cambiando solo text ----
    const before = msg1.parts.map((p) => p.id)
    const r2 = await upd("prt_alfa_probe", "ORDER-PROBE prt_alfa_probe REWRITTEN")
    if (r2.error || !r2.data) {
      console.error("[smoke] FAIL: re-upsert alfa failed", r2.error)
      process.exit(1)
    }
    entries = await allMessages(sessionID)
    dumpOrdered("SONDA 2 (tras re-upsert alfa)", entries)
    const msg2 = entries.find((m) => m.info.id === targetMessageID)
    if (!msg2) {
      console.error("[smoke] FAIL: target message missing on read-back 2")
      process.exit(1)
    }
    const after = msg2.parts.map((p) => p.id)
    const alfaBefore = before.indexOf("prt_alfa_probe")
    const alfaAfter = after.indexOf("prt_alfa_probe")
    console.log(`[smoke] alfa position before=${alfaBefore} after=${alfaAfter} moved=${alfaBefore !== alfaAfter}`)
    const probeIDs2 = after.filter((id) => id.endsWith("_probe"))
    console.log(`[smoke] probe order read-back 2: ${JSON.stringify(probeIDs2)}`)

    // ---- Sonda 3: pre-existentes vs nuevas ----
    const firstProbeIdx = Math.min(...INSERTION.map((id) => after.indexOf(id)))
    const lastPreIdx = Math.max(...preExistingIDs.map((id) => after.indexOf(id)).filter((i) => i >= 0))
    console.log(`[smoke] last pre-existing index=${lastPreIdx} first probe index=${firstProbeIdx}`)
    console.log(`[smoke] new parts appended after pre-existing=${lastPreIdx >= 0 && firstProbeIdx > lastPreIdx}`)

    // ---- Veredicto fail-closed ----
    const stableAcrossRewrite = JSON.stringify(probeIDs1) === JSON.stringify(probeIDs2)
    console.log(`[smoke] order stable across rewrite=${stableAcrossRewrite}`)
    if (isAsc && stableAcrossRewrite) verdict = "ORDER-BY-ID-ASC"
    else if (isInsertion && stableAcrossRewrite) verdict = "ORDER-BY-INSERTION"
    else verdict = `OTHER probe1=${JSON.stringify(probeIDs1)} probe2=${JSON.stringify(probeIDs2)}`
    console.log(`[smoke] VERDICT part-order: ${verdict}`)

    if (verdict.startsWith("OTHER") || !stableAcrossRewrite) {
      console.error("[smoke] FAIL: order ambiguous or unstable — needs human reading of the dumps above")
      process.exit(1)
    }
  } finally {
    const del = await client.session.delete({ sessionID, directory })
    console.log(`\n[smoke] cleanup delete status=${del.response?.status}`)
  }
}

main().catch((e) => {
  console.error("[smoke] fatal", e)
  process.exit(1)
})
