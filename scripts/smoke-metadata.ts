// Smoke bloqueante I2/I3: round-trip de metadata/synthetic + rewrite de metadata.preview.
// Preguntas que responde (diseño docs/01:77-78 I2, 163-164 I3):
//   - ¿un upsert con `synthetic: true` + `metadata` persiste ambos verbatim?        (A)
//   - ¿reescribir `tool.state.output` + `metadata.preview` persiste ambos?          (B)
//   - ¿re-tocar solo `text` preserva `metadata`/`synthetic` (merge, no wipe)?       (C)
//   - ¿un stub `prt_stub_*` con `metadata` persiste?                                (D)
//
// Uso:  PORT=4712 LOG=/tmp/opencode/distill-smoke-2.log scripts/run-smoke.sh scripts/smoke-metadata.ts
//
// Diseño sin-modelo (deliberado): las 4 sondas preguntan por PERSISTENCIA en el
// store, no por comportamiento del LLM. El mensaje contenedor se crea con
// `prompt(noReply:true)` (sin llamada al modelo: rápido y determinista). La tool
// part de la sonda B se siembra por upsert (la primitiva es UPSERT: crear y
// reescribir pasan por el mismo path de persistencia) y luego se reescribe —
// eso ejercita exactamente el escenario de docs/02:77-82 (preview stale).
//
// Seguridad: crea una sesión NUEVA en un directorio scratch y la BORRA al final.
// No toca sesiones reales ni el server diario (:4096). No imprime secretos.
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { mkdirSync } from "node:fs"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[smoke] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const directory = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-metadata"
const client = createOpencodeClient({ baseUrl })

mkdirSync(directory, { recursive: true })

type Probe = { label: string; status?: number; ok: boolean; data?: unknown; error?: unknown; threw?: string }

async function probe(label: string, fn: () => Promise<unknown>): Promise<Probe> {
  try {
    const r = (await fn()) as { response?: { status?: number }; data?: unknown; error?: unknown }
    return { label, status: r?.response?.status, ok: r?.error === undefined && r?.data !== undefined, data: r?.data, error: r?.error }
  } catch (e) {
    return { label, ok: false, threw: e instanceof Error ? e.message : String(e) }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

type Entry = { info: { id: string; role: string }; parts: Part[] }

async function allMessages(sessionID: string): Promise<Entry[]> {
  const r = await client.session.messages({ sessionID, directory })
  return (r.data ?? []) as Entry[]
}

function findPart(entries: Entry[], partID: string): { part: Part; messageID: string } | undefined {
  for (const m of entries) {
    const p = m.parts.find((x) => x.id === partID)
    if (p) return { part: p, messageID: m.info.id }
  }
  return undefined
}

async function main(): Promise<void> {
  console.log(`[smoke] server=${baseUrl} dir=${directory}`)

  const created = await client.session.create({ directory, title: "smoke-metadata" })
  if (created.error || !created.data) {
    console.error("[smoke] create failed", created.error)
    process.exit(1)
  }
  const sessionID = created.data.id
  console.log(`[smoke] session=${sessionID}`)

  let failures = 0
  const verdict = (label: string, pass: boolean, detail?: unknown): void => {
    console.log(`[smoke] VERDICT ${label}: ${pass ? "PASS" : "FAIL"}` + (detail !== undefined ? ` ${JSON.stringify(detail)}` : ""))
    if (!pass) failures++
  }

  try {
    const seeded = await withTimeout(
      client.session.prompt({ sessionID, directory, noReply: true, parts: [{ type: "text", text: "seed" }] }),
      60_000,
      "seed-prompt",
    )
    if (seeded.error || !seeded.data) {
      console.error("[smoke] seed prompt failed", seeded.error)
      failures++
      return
    }
    const entries = await allMessages(sessionID)
    const targetMessageID = entries[0]?.info.id
    if (!targetMessageID) {
      console.error("[smoke] no messages after seed")
      failures++
      return
    }
    console.log(`[smoke] container message=${targetMessageID} role=${entries[0]?.info.role}`)

    const upd = (messageID: string, partID: string, part: Part) =>
      client.part.update({ sessionID, messageID, partID, directory, part })

    // ---- Probe A: parte text NUEVA con synthetic + metadata ----
    const partA = {
      id: "prt_meta_probe", sessionID, messageID: targetMessageID,
      type: "text", text: "DISTILLED-PROBE",
      synthetic: true, metadata: { distilled: true, traceRef: "ts_probe" },
    } as unknown as Part
    const ra = await probe("A upsert.text.synthetic+metadata", () => upd(targetMessageID, partA.id, partA))
    console.log("[smoke] A upsert:", JSON.stringify({ status: ra.status, ok: ra.ok, error: ra.error ?? undefined, threw: ra.threw }))
    const readA = findPart(await allMessages(sessionID), partA.id)?.part as unknown as
      | (TextPart & { metadata?: Record<string, unknown> })
      | undefined
    console.log("[smoke] A read-back:", JSON.stringify(readA))
    verdict(
      "A metadata+synthetic round-trip",
      !!readA && readA.synthetic === true && readA.metadata?.["distilled"] === true && readA.metadata?.["traceRef"] === "ts_probe",
    )

    const now = Date.now()
    const toolSeed = {
      id: "prt_tool_probe", sessionID, messageID: targetMessageID,
      type: "tool", callID: "call_probe_1", tool: "read",
      state: {
        status: "completed", input: { path: "smoke.txt" },
        output: "ORIGINAL-OUTPUT", title: "read smoke.txt",
        metadata: {}, time: { start: now - 1000, end: now },
      },
      metadata: { preview: "ORIGINAL-PREVIEW" },
    } as unknown as Part
    const rbSeed = await probe("B tool.seed(upsert)", () => upd(targetMessageID, toolSeed.id, toolSeed))
    console.log("[smoke] B seed:", JSON.stringify({ status: rbSeed.status, ok: rbSeed.ok, error: rbSeed.error ?? undefined, threw: rbSeed.threw }))
    const readB0 = findPart(await allMessages(sessionID), toolSeed.id)?.part as unknown as ToolPart | undefined
    console.log("[smoke] B seed read-back:", JSON.stringify(readB0))

    if (readB0?.type === "tool" && readB0.state.status === "completed") {
      const newOutput = "REWRITTEN-TOOL-OUTPUT"
      const newPreview = "REWRITTEN-PREVIEW"
      const rewritten = {
        ...readB0,
        state: { ...readB0.state, output: newOutput },
        metadata: { ...((readB0 as ToolPart).metadata ?? {}), preview: newPreview },
      }
      const rb = await probe("B tool.update.output+preview", () => upd(targetMessageID, toolSeed.id, rewritten as Part))
      console.log("[smoke] B rewrite:", JSON.stringify({ status: rb.status, ok: rb.ok, error: rb.error ?? undefined, threw: rb.threw }))
      const readB = findPart(await allMessages(sessionID), toolSeed.id)?.part as unknown as ToolPart | undefined
      console.log("[smoke] B read-back:", JSON.stringify(readB))
      const st = readB?.state
      verdict(
        "B output+preview rewrite",
        !!readB &&
          st?.status === "completed" &&
          (st as { output?: unknown }).output === newOutput &&
          (readB.metadata as Record<string, unknown> | undefined)?.["preview"] === newPreview,
      )
    } else {
      verdict("B output+preview rewrite (seed tool part not readable as completed)", false)
    }

    // ---- Probe C: re-tocar SOLO text de la parte A; metadata/synthetic deben sobrevivir ----
    if (readA) {
      const touched = { ...(readA as unknown as Record<string, unknown>), text: "DISTILLED-PROBE-V2" } as unknown as Part
      const rc = await probe("C text-only re-update", () => upd(targetMessageID, partA.id, touched))
      console.log("[smoke] C upsert:", JSON.stringify({ status: rc.status, ok: rc.ok, error: rc.error ?? undefined, threw: rc.threw }))
      const readC = findPart(await allMessages(sessionID), partA.id)?.part as unknown as
        | (TextPart & { metadata?: Record<string, unknown> })
        | undefined
      console.log("[smoke] C read-back:", JSON.stringify(readC))
      verdict(
        "C metadata/synthetic survive text-only touch",
        !!readC &&
          readC.text === "DISTILLED-PROBE-V2" &&
          readC.synthetic === true &&
          readC.metadata?.["distilled"] === true &&
          readC.metadata?.["traceRef"] === "ts_probe",
      )
    } else {
      verdict("C metadata/synthetic survive text-only touch (A failed, nothing to re-touch)", false)
    }

    // ---- Probe D: stub prt_stub_* con metadata ----
    const partD = {
      id: "prt_stub_probe", sessionID, messageID: targetMessageID,
      type: "text", text: "stub: what this message did",
      metadata: { stub: true, traceRef: "ts_probe" },
    } as unknown as Part
    const rd = await probe("D upsert.stub.metadata", () => upd(targetMessageID, partD.id, partD))
    console.log("[smoke] D upsert:", JSON.stringify({ status: rd.status, ok: rd.ok, error: rd.error ?? undefined, threw: rd.threw }))
    const readD = findPart(await allMessages(sessionID), partD.id)?.part as unknown as
      | (TextPart & { metadata?: Record<string, unknown> })
      | undefined
    console.log("[smoke] D read-back:", JSON.stringify(readD))
    verdict("D stub metadata round-trip", !!readD && readD.metadata?.["stub"] === true)

    console.log(`\n[smoke] DONE failures=${failures}`)
  } finally {
    const del = await client.session.delete({ sessionID, directory })
    console.log(`\n[smoke] cleanup delete status=${del.response?.status}`)
  }

  if (failures > 0) process.exit(1)
}

main().catch((e) => {
  console.error("[smoke] fatal", e)
  process.exit(1)
})
