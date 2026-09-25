// Smoke informativo (one-time, NO gate de regresión — D15):
// Q1 (snapshot al modelo) + Q5 (metadata al modelo) [+ Q2 si hay provider].
//
// Q1: tres sesiones idénticas con tool call real (patrón case-file de task #17,
// estable en ambos modelos); en el último assistant del turno 1 se inyecta:
//   A control (nada) | B snapshot part con marker SNAPSHOT-MARK-42 (~2k tokens)
//   C text part grande (~2k tokens, control positivo del instrumento)
// Se mide step-finish.tokens.input del turno siguiente:
//   Δ B−A ≈ 0 → snapshot NO se serializa (confirma docs/03 §3).
//   Δ C−A grande → el instrumento detecta (sin esto, nada es afirmable).
//
// Q5: dos sesiones idénticas; en E se inyecta text part CORTA con metadata
// GRANDE (~8 KB de marker repetido). Turno siguiente:
//   - Si responde → Δ E−D ≈ 0 → metadata no viaja al modelo.
//   - Si RECHAZA con "ModelMessage[] schema" (finding task #17) → ESA es la
//     respuesta Q5 (metadata no solo no se serializa: rompe el prompt).
//     No se inventa ningún Δ.
//
// Q2: lista providers configurados; si hay anthropic/bedrock disponible,
// repite la medición reasoning-tokens contra ese provider. Si no → SKIP
// documentado (la limitación va al README en task #22).
//
// Uso: PORT=4718 LOG=/tmp/opencode/distill-smoke-19.log scripts/run-smoke.sh scripts/smoke-context-markers.ts
//
// Seguridad: sesiones scratch en /tmp/opencode/, borradas en `finally`.
// Jamás toca :4096 ni sesiones reales. Informativo: no bloquea el build,
// no presenta nada como certeza (veredictos "suggest", no "prove").
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part, SnapshotPart, TextPart } from "@opencode-ai/sdk/v2"
import { mkdirSync, writeFileSync } from "node:fs"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[markers] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const baseDir = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-context-markers"
const client = createOpencodeClient({ baseUrl })
const MODEL = { providerID: "litellm", modelID: process.env.SMOKE_MODEL ?? "muse-spark-1.3-contributor" }

const TURN_TIMEOUT = 240_000

// Masa comparable a smoke-reasoning-tokens.ts (~3.5k tokens si se serializara).
const SNAP_MARK = "SNAPSHOT-MARK-42 "
const FILLER_SNAP = SNAP_MARK.repeat(700) // ~12.6k chars
const FILLER_TEXT = "filler ".repeat(2000) // ~14k chars
// Q5: texto corto visible, metadata grande (~8 KB de marker repetido).
const META_MARK = "META-MARK-77 "
const META_BLOB = META_MARK.repeat(600) // ~7.8k chars

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

type Entry = { info: { id: string; role: string; error?: unknown }; parts: Part[] }

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

async function fetchEntries(sessionID: string, directory: string): Promise<Entry[]> {
  const r = await client.session.messages({ sessionID, directory })
  return ((r.data ?? []) as Entry[]).slice().sort((a, b) => a.info.id.localeCompare(b.info.id))
}

function inputTokens(entries: Entry[]): number | undefined {
  const assistants = entries.filter((m) => m.info.role === "assistant")
  const last = assistants[assistants.length - 1]
  const sf = last?.parts.find((p) => p.type === "step-finish")
  if (sf !== undefined && sf.type === "step-finish") return sf.tokens.input
  return undefined
}

function lastAssistantID(entries: Entry[]): string | undefined {
  const assistants = entries.filter((m) => m.info.role === "assistant")
  return assistants[assistants.length - 1]?.info.id
}

function lastAssistantError(entries: Entry[]): string | undefined {
  const assistants = entries.filter((m) => m.info.role === "assistant")
  const last = assistants[assistants.length - 1]
  if ((last?.parts.length ?? -1) !== 0) return undefined
  const data = last?.info.error as { data?: { message?: string } } | undefined
  return JSON.stringify(data?.data?.message ?? last?.info.error)?.slice(0, 200)
}

// Una sesión: turno con tool call real → inyección → turno de comparación.
// Devuelve tokens.input del turno 2, o un rechazo documentado.
async function runArm(
  label: string,
  keyword: string,
  inject: (ctx: { sessionID: string; assistantID: string; directory: string }) => Promise<void>,
): Promise<{ tokens?: number; rejected?: string }> {
  const directory = `${baseDir}/${label}`
  mkdirSync(directory, { recursive: true })
  writeFileSync(`${directory}/case.txt`, caseFileContent(keyword, label))
  const created = await client.session.create({ directory, title: `smoke-markers-${label}` })
  if (created.error !== undefined || created.data === undefined) throw new Error(`create ${label} failed`)
  const sessionID = created.data.id
  try {
    const t1 = await withTimeout(
      client.session.prompt({
        sessionID,
        directory,
        model: MODEL,
        parts: [
          {
            type: "text",
            text: `Read the file case.txt in the current directory with the read tool. Then reply with the full line that contains the word ${keyword} and nothing else.`,
          },
        ],
      }),
      TURN_TIMEOUT,
      `${label}-turn1`,
    )
    if (t1.error !== undefined) throw new Error(`${label} turn1 failed: ${JSON.stringify(t1.error).slice(0, 200)}`)
    const after1 = await fetchEntries(sessionID, directory)
    const assistantID = lastAssistantID(after1)
    if (assistantID === undefined) throw new Error(`${label}: sin assistant tras turno 1`)
    console.log(`[markers] ${label}: turno1 ok assistant=${assistantID} parts=${after1.filter((e) => e.info.role === "assistant").pop()?.parts.map((p) => p.type).join(",")}`)

    await inject({ sessionID, assistantID, directory })

    const t2 = await withTimeout(
      client.session.prompt({
        sessionID,
        directory,
        model: MODEL,
        parts: [{ type: "text", text: "Reply with the single word OK." }],
      }),
      TURN_TIMEOUT,
      `${label}-turn2`,
    )
    if (t2.error !== undefined) {
      console.log(`[markers] ${label}: turno2 prompt-error=${JSON.stringify(t2.error).slice(0, 200)}`)
      return { rejected: `prompt-error ${JSON.stringify(t2.error).slice(0, 200)}` }
    }
    const after2 = await fetchEntries(sessionID, directory)
    const rej = lastAssistantError(after2)
    if (rej !== undefined) {
      console.log(`[markers] ${label}: turno2 REJECTED error=${rej}`)
      return { rejected: rej }
    }
    const tokens = inputTokens(after2)
    console.log(`[markers] ${label}: turno2 tokens.input=${tokens}`)
    return { tokens }
  } finally {
    await client.session.delete({ sessionID, directory })
  }
}

async function main(): Promise<void> {
  console.log(`[markers] server=${baseUrl} model=${MODEL.providerID}/${MODEL.modelID}`)
  let inconclusive = false
  const verdict = (label: string, pass: boolean, detail?: unknown): void => {
    console.log(`[markers] VERDICT ${label}: ${pass ? "PASS" : "FAIL"}` + (detail !== undefined ? ` ${JSON.stringify(detail)}` : ""))
    if (!pass) inconclusive = true
  }

  // ---- Q1: snapshot al modelo ----
  console.log("[markers] --- Q1: snapshot part ---")
  const q1a = await runArm("q1-a-control", "QUASAR", async () => {})
  const q1b = await runArm("q1-b-snapshot", "QUASAR", async ({ sessionID, assistantID, directory }) => {
    const part: SnapshotPart = {
      id: "prt_snap_probe",
      sessionID,
      messageID: assistantID,
      type: "snapshot",
      snapshot: FILLER_SNAP,
    }
    const r = await client.part.update({ sessionID, messageID: assistantID, partID: part.id, directory, part })
    console.log(`[markers] q1-b inject status=${r.response?.status} error=${JSON.stringify(r.error)?.slice(0, 120)}`)
  })
  const q1c = await runArm("q1-c-text", "QUASAR", async ({ sessionID, assistantID, directory }) => {
    const part = {
      id: "prt_big_text",
      sessionID,
      messageID: assistantID,
      type: "text",
      text: FILLER_TEXT,
    } as Part
    const r = await client.part.update({ sessionID, messageID: assistantID, partID: part.id, directory, part })
    console.log(`[markers] q1-c inject status=${r.response?.status} error=${JSON.stringify(r.error)?.slice(0, 120)}`)
  })

  console.log(`[markers] Q1 turn2 input — A(control)=${q1a.tokens} B(+snapshot)=${q1b.tokens} C(+text)=${q1c.tokens}`)
  if (q1a.tokens === undefined || q1b.tokens === undefined || q1c.tokens === undefined) {
    console.log("[markers] Q1 inconclusive: falta step-finish/tokens en algún brazo (o hubo rechazo)")
    console.log(`[markers] Q1 rechazos — A=${q1a.rejected ?? "no"} B=${q1b.rejected ?? "no"} C=${q1c.rejected ?? "no"}`)
    inconclusive = true
  } else {
    const dSnap = q1b.tokens - q1a.tokens
    const dText = q1c.tokens - q1a.tokens
    console.log(`[markers] Q1 delta B-A (snapshot) = ${dSnap}`)
    console.log(`[markers] Q1 delta C-A (text)     = ${dText}`)
    verdict("Q1 instrument (text delta detecta reenvío)", dText > 1000, { dText })
    // Informativo (D15): sugiere, no prueba. Umbral holgado: si el snapshot
    // viajara (~3k tokens), el delta sería de miles, no de cientos.
    verdict("Q1 snapshot-no-serializado (suggest, Δ≈0)", dSnap < 500, { dSnap })
  }

  // ---- Q5: metadata al modelo ----
  console.log("[markers] --- Q5: metadata grande en text part ---")
  const q5d = await runArm("q5-d-control", "NEBULA", async () => {})
  const q5e = await runArm("q5-e-meta", "NEBULA", async ({ sessionID, assistantID, directory }) => {
    const part = {
      id: "prt_meta_probe",
      sessionID,
      messageID: assistantID,
      type: "text",
      text: "SHORT VISIBLE TEXT",
      metadata: { blob: META_BLOB },
    } as Part
    const r = await client.part.update({ sessionID, messageID: assistantID, partID: part.id, directory, part })
    console.log(`[markers] q5-e inject status=${r.response?.status} error=${JSON.stringify(r.error)?.slice(0, 120)} metaBytes≈${META_BLOB.length}`)
  })

  console.log(`[markers] Q5 turn2 input — D(control)=${q5d.tokens} E(+metadata)=${q5e.tokens}`)
  if (q5e.rejected !== undefined) {
    // Finding task #17: el rechazo ES la respuesta Q5. No se inventa ningún Δ.
    console.log(`[markers] Q5 ANSWER-BY-REJECTION: el turno siguiente con metadata no-vacía fue rechazado: ${q5e.rejected}`)
    verdict("Q5 metadata-rompe-prompt (rejection documentada, supersede framing Δ)", true, { rejected: q5e.rejected })
  } else if (q5d.tokens === undefined || q5e.tokens === undefined) {
    console.log("[markers] Q5 inconclusive: falta step-finish/tokens sin rechazo claro")
    inconclusive = true
  } else {
    const dMeta = q5e.tokens - q5d.tokens
    console.log(`[markers] Q5 delta E-D (metadata) = ${dMeta}`)
    verdict("Q5 metadata-no-serializada (suggest, Δ≈0)", dMeta < 500, { dMeta })
  }

  // ---- Q2: providers disponibles ----
  console.log("[markers] --- Q2: provider check ---")
  try {
    const provs = await client.config.providers()
    const ids: Array<string> = []
    const data = provs.data as unknown as
      | { providers?: Array<{ id?: string; models?: Record<string, unknown> }> }
      | undefined
    const byId = new Map<string, { id?: string; models?: Record<string, unknown> }>()
    for (const p of data?.providers ?? []) {
      if (typeof p.id === "string") {
        ids.push(p.id)
        byId.set(p.id, p)
      }
    }
    console.log(`[markers] Q2 configured providers: ${JSON.stringify(ids)}`)
    const strict = ids.filter((id) => /anthropic|bedrock/i.test(id))
    if (strict.length === 0) {
      console.log("[markers] Q2 SKIP: no hay provider Anthropic/Bedrock en el server aislado — limitación para task #22 (README)")
      verdict("Q2 skipped (sin provider estricto, documentar limitación)", true, { providers: ids })
    } else {
      // Q2: el provider figura configurado pero puede no tener credencial/modelo
      // vivo en este entorno. Se intenta la medición real; si el turno no
      // responde, se documenta como SKIP-con-evidencia (no se finge un Δ).
      const strictID = strict[0] as string
      const models = Object.keys(byId.get(strictID)?.models ?? {})
      console.log(`[markers] Q2 strict provider=${strictID} models=${JSON.stringify(models.slice(0, 10))}`)
      const q2model = models.length > 0 ? (models[0] as string) : undefined
      if (q2model === undefined) {
        console.log("[markers] Q2 SKIP: provider estricto sin modelos listados — limitación para task #22 (README)")
        verdict("Q2 skipped (strict sin modelos, documentar limitación)", true, { strict })
      } else {
        const q2dir = `${baseDir}/q2-strict`
        mkdirSync(q2dir, { recursive: true })
        writeFileSync(`${q2dir}/case.txt`, caseFileContent("QUASAR", "q2"))
        let q2session = ""
        try {
          const created = await client.session.create({ directory: q2dir, title: "smoke-markers-q2" })
          if (created.error !== undefined || created.data === undefined) throw new Error("create q2 failed")
          q2session = created.data.id
          const t1 = await withTimeout(
            client.session.prompt({
              sessionID: q2session,
              directory: q2dir,
              model: { providerID: strictID, modelID: q2model },
              parts: [{ type: "text", text: "Reply with the single word OK." }],
            }),
            120_000,
            "q2-turn1",
          )
          if (t1.error !== undefined) {
            console.log(`[markers] Q2 SKIP: turno contra ${strictID}/${q2model} falló: ${JSON.stringify(t1.error).slice(0, 200)} — sin credencial viva en este entorno; limitación para task #22 (README)`)
            verdict("Q2 skipped (strict sin credencial viva, documentar limitación)", true, { strict: strictID, model: q2model })
          } else {
            // Q2 real: repetición de smoke-reasoning-tokens.ts contra el
            // provider estricto (3 brazos, mismo instrumento tokens.input).
            const strictModel = { providerID: strictID, modelID: q2model }
            console.log(`[markers] Q2: midiendo reasoning-tokens contra ${strictID}/${q2model}`)
            const q2run = async (
              label: string,
              inject: "none" | "reasoning" | "text",
            ): Promise<number | undefined> => {
              const dir = `${baseDir}/q2-${label}`
              mkdirSync(dir, { recursive: true })
              const created = await client.session.create({ directory: dir, title: `smoke-markers-q2-${label}` })
              if (created.error !== undefined || created.data === undefined) throw new Error(`create q2-${label} failed`)
              const sid = created.data.id
              try {
                const t1 = await withTimeout(
                  client.session.prompt({ sessionID: sid, directory: dir, model: strictModel, parts: [{ type: "text", text: "Say OK." }] }),
                  120_000,
                  `q2-${label}-turn1`,
                )
                if (t1.error !== undefined) throw new Error(`q2-${label} turn1: ${JSON.stringify(t1.error).slice(0, 160)}`)
                const after1 = await fetchEntries(sid, dir)
                const aid = lastAssistantID(after1)
                if (aid === undefined) throw new Error(`q2-${label}: sin assistant`)
                if (inject === "reasoning") {
                  const part = {
                    id: "prt_q2_reasoning",
                    sessionID: sid,
                    messageID: aid,
                    type: "reasoning",
                    text: FILLER_TEXT,
                    time: { start: Date.now() - 1000, end: Date.now() },
                  } as Part
                  await client.part.update({ sessionID: sid, messageID: aid, partID: part.id, directory: dir, part })
                } else if (inject === "text") {
                  const part = { id: "prt_q2_text", sessionID: sid, messageID: aid, type: "text", text: FILLER_TEXT } as Part
                  await client.part.update({ sessionID: sid, messageID: aid, partID: part.id, directory: dir, part })
                }
                const t2 = await withTimeout(
                  client.session.prompt({ sessionID: sid, directory: dir, model: strictModel, parts: [{ type: "text", text: "Reply with the single word OK." }] }),
                  120_000,
                  `q2-${label}-turn2`,
                )
                if (t2.error !== undefined) {
                  console.log(`[markers] q2-${label}: turno2 prompt-error=${JSON.stringify(t2.error).slice(0, 160)}`)
                  return undefined
                }
                const after2 = await fetchEntries(sid, dir)
                const rej = lastAssistantError(after2)
                if (rej !== undefined) {
                  console.log(`[markers] q2-${label}: turno2 REJECTED error=${rej}`)
                  return undefined
                }
                return inputTokens(after2)
              } finally {
                await client.session.delete({ sessionID: sid, directory: dir })
              }
            }
            try {
              const qa = await q2run("control", "none")
              const qb = await q2run("reasoning", "reasoning")
              const qc = await q2run("text", "text")
              console.log(`[markers] Q2 turn2 input — A(control)=${qa} B(+reasoning)=${qb} C(+text)=${qc}`)
              if (qa === undefined || qb === undefined || qc === undefined) {
                console.log("[markers] Q2 inconclusive contra provider estricto (rechazo o sin tokens) — documentado, no afirmado")
                verdict("Q2 strict-inconclusive (documentado)", true, { qa, qb, qc })
              } else {
                console.log(`[markers] Q2 delta B-A (reasoning) = ${qb - qa}`)
                console.log(`[markers] Q2 delta C-A (text)      = ${qc - qa}`)
                verdict("Q2 strict-medido (informativo, ver deltas arriba)", true, { dReason: qb - qa, dText: qc - qa })
              }
            } catch (e) {
              console.log(`[markers] Q2 SKIP: ${e instanceof Error ? e.message : String(e)} — limitación para task #22 (README)`)
              verdict("Q2 skipped (error, documentar limitación)", true, { strict: strictID })
            }
          }
        } catch (e) {
          console.log(`[markers] Q2 SKIP: ${e instanceof Error ? e.message : String(e)} — limitación para task #22 (README)`)
          verdict("Q2 skipped (error, documentar limitación)", true, { strict: strictID })
        } finally {
          if (q2session !== "") await client.session.delete({ sessionID: q2session, directory: q2dir })
        }
      }
    }
  } catch (e) {
    console.log(`[markers] Q2 provider-list falló: ${e instanceof Error ? e.message : String(e)} — SKIP documentado`)
    verdict("Q2 skipped (list falló, documentar limitación)", true, {})
  }

  // Lectura de control: el marker de snapshot persiste en el store aunque no
  // viaje al modelo (distingue "no serializado" de "write perdido").
  console.log("[markers] DONE")
  if (inconclusive) {
    console.log("[markers] INCONCLUSIVE: algún instrumento falló — no afirmar nada, revisar el log")
    process.exit(1)
  }
  console.log("[markers] ALL-INSTRUMENTS-OK (veredictos informativos arriba, D15: sugieren, no prueban)")
}

main().catch((e) => {
  console.error("[markers] fatal", e)
  process.exit(1)
})
