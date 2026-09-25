// Smoke bloqueante I7: frontera de compactación legible (tail_start_id).
// NOTA: v2.session.compact responde 503 "not available yet" en 1.18.32.
// La vía operativa es session.summarize, que escribe el mismo par
// user+compaction / assistant+summary. Este smoke usa summarize y documenta la forma.
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part } from "@opencode-ai/sdk/v2"
import { mkdirSync, writeFileSync } from "node:fs"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[smoke] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const directory = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-compaction-boundary"
const client = createOpencodeClient({ baseUrl })

mkdirSync(directory, { recursive: true })
writeFileSync(`${directory}/smoke.txt`, "SENTINEL-42\n")

const TURN1 =
  "You MUST call the read tool on the file smoke.txt in the current directory. " +
  "Do not answer from memory. After the tool returns, reply with exactly the file's content."
const TURN2 = "Repeat back the sentinel value you just read, in one short sentence."

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

type Entry = { info: { id: string; role: string; [k: string]: unknown }; parts: Part[] }

async function allMessages(sessionID: string): Promise<Entry[]> {
  const r = await client.session.messages({ sessionID, directory })
  if (r.error || !r.data) throw new Error(`session.messages failed: ${JSON.stringify(r.error)}`)
  return r.data as unknown as Entry[]
}

async function main(): Promise<void> {
  console.log(`[smoke] server=${baseUrl} dir=${directory}`)

  const created = await client.session.create({ directory, title: "smoke-compaction-boundary" })
  if (created.error || !created.data) {
    console.error("[smoke] create failed", created.error)
    process.exit(1)
  }
  const sessionID = created.data.id
  console.log(`[smoke] session=${sessionID}`)

  try {
    // ---- Turnos 1-2: historial con tool calls (modelo explícito: gpt-oss-20b es rápido y estable) ----
    const MODEL = { providerID: "litellm", modelID: "gpt-oss-20b" }
    for (const [i, text] of [TURN1, TURN2].entries()) {
      const res = await withTimeout(
        client.session.prompt({ sessionID, directory, model: MODEL, parts: [{ type: "text", text }] }),
        120_000,
        `turn${i + 1}`,
      )
      if (res.error || !res.data) {
        console.error(`[smoke] prompt turn${i + 1} failed`, res.error)
        process.exit(1)
      }
    }

    const before = await allMessages(sessionID)
    const beforeIDs = before.map((m) => m.info.id)
    console.log(`\n[smoke] BEFORE compact: ${before.length} mensajes`)
    for (const m of before) {
      console.log(`  msg ${m.info.id} (${m.info.role}) — ${m.parts.length} partes [${m.parts.map((p) => p.type).join(",")}]`)
    }

    const v2 = await withTimeout(client.v2.session.compact({ sessionID }), 60_000, "v2.compact")
    console.log(`\n[smoke] v2.session.compact status=${v2.response?.status} error=${JSON.stringify(v2.error ?? null)}`)

    const s = await withTimeout(
      client.session.summarize({ sessionID, directory, providerID: MODEL.providerID, modelID: MODEL.modelID }),
      300_000,
      "summarize",
    )
    if (s.error) {
      console.error("[smoke] summarize failed", s.error)
      process.exit(1)
    }
    console.log(`[smoke] session.summarize data=${JSON.stringify(s.data)} status=${s.response?.status}`)

    // ---- Read-back ----
    const after = await allMessages(sessionID)
    console.log(`\n[smoke] AFTER compact: ${after.length} mensajes`)
    for (const m of after) {
      console.log(`  msg ${m.info.id} (${m.info.role}) — ${m.parts.length} partes [${m.parts.map((p) => p.type).join(",")}]`)
    }

    // ---- Sonda 1: la parte compaction ----
    const holders = after.flatMap((m) => m.parts.map((p) => ({ p, messageID: m.info.id, role: m.info.role })))
    const comp = holders.find((x) => x.p.type === "compaction")
    if (!comp) {
      console.error("[smoke] FAIL: no se encontró ninguna parte type:\"compaction\" tras compact")
      process.exit(1)
    }
    console.log(`\n[smoke] PROBE1 compaction part vive en msg ${comp.messageID} (role=${comp.role})`)
    console.log("[smoke] PROBE1 compaction part FULL JSON:")
    console.log(JSON.stringify(comp.p, null, 2))
    const tail = (comp.p as { tail_start_id?: unknown }).tail_start_id
    const tailLegible = typeof tail === "string" && tail.length > 0
    console.log(`[smoke] PROBE1 tail_start_id legible: ${tailLegible ? `YES (${tail})` : "NO"}`)
    console.log(`[smoke] PROBE1 auto=${JSON.stringify((comp.p as { auto?: unknown }).auto)} overflow=${JSON.stringify((comp.p as { overflow?: unknown }).overflow)}`)
    const compMsg = after.find((m) => m.info.id === comp.messageID)
    console.log("[smoke] PROBE1 compaction holder message FULL JSON:")
    console.log(JSON.stringify(compMsg, null, 2))

    // ---- Sonda 2: ¿siguen presentes los mensajes previos? (storage intacto) ----
    const afterIDs = new Set(after.map((m) => m.info.id))
    const missing = beforeIDs.filter((id) => !afterIDs.has(id))
    console.log(`\n[smoke] PROBE2 mensajes previos presentes: ${beforeIDs.length - missing.length}/${beforeIDs.length}`)
    if (missing.length > 0) console.log(`[smoke] PROBE2 faltantes: ${JSON.stringify(missing)}`)
    console.log(`[smoke] PROBE2 VERDICT storage-intact: ${missing.length === 0 ? "YES" : "NO"}`)

    // ---- Sonda 3: ¿el assistant del summary tiene summary:true? ----
    const summaryMsgs = after.filter((m) => (m.info as { summary?: unknown }).summary === true)
    console.log(`\n[smoke] PROBE3 mensajes con summary:true: ${summaryMsgs.length}`)
    for (const m of summaryMsgs) {
      console.log(`[smoke] PROBE3 summary msg ${m.info.id} (role=${m.info.role}) FULL JSON:`)
      console.log(JSON.stringify(m, null, 2))
    }
    console.log(`[smoke] PROBE3 VERDICT summary-flag: ${summaryMsgs.length > 0 ? "YES" : "NO"}`)

    // ---- Vista filtrada (context = lo que ve el modelo) ----
    try {
      const ctx = await client.v2.session.context({ sessionID })
      const ctxData = (ctx.data as unknown as { data?: unknown[] }) ?? {}
      const n = Array.isArray(ctxData) ? ctxData.length : ((ctxData as { data?: unknown[] }).data?.length ?? "?")
      console.log(`\n[smoke] BONUS v2.context mensajes visibles al modelo: ${JSON.stringify(n)} (total en storage: ${after.length})`)
    } catch (e) {
      console.log(`\n[smoke] BONUS v2.context failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    // ---- Veredicto I7 ----
    console.log(`\n[smoke] VERDICT I7-boundary: ${tailLegible ? `tail_start_id=${tail}` : "FALLBACK-session-start (tail_start_id no legible)"}`)
  } finally {
    const del = await client.session.delete({ sessionID, directory })
    console.log(`\n[smoke] cleanup delete status=${del.response?.status}`)
  }
}

main().catch((e) => {
  console.error("[smoke] fatal", e)
  process.exit(1)
})
