// Smoke test empírico: qué acepta realmente `part.update` / `part.delete` en OpenCode.
// Preguntas que responde:
//   - ¿reescribir text / reasoning / tool.output?  - ¿cambiar el type?
//   - ¿upsert (crear una parte nueva)?             - ¿404 o 400?
//   - ¿tocar el accounting (step-finish)?          - ¿la mutación llega al modelo?
//
// Uso:  OPENCODE_URL=http://127.0.0.1:4711 bun run scripts/smoke-part-update.ts
//
// Seguridad: crea una sesión NUEVA en un directorio scratch y la BORRA al final.
// No toca sesiones reales. No imprime secretos.
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { mkdirSync, writeFileSync } from "node:fs"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[smoke] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const directory = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-part-update"
const client = createOpencodeClient({ baseUrl })

mkdirSync(directory, { recursive: true })
writeFileSync(`${directory}/smoke.txt`, "SENTINEL-42\n")

const TURN1 =
  "You MUST call the read tool on the file smoke.txt in the current directory. " +
  "Do not answer from memory. After the tool returns, reply with exactly the file's content."
const TURN2 = "What is the launch code? Reply with only the code."

type Probe = { label: string; status?: number; ok: boolean; data?: unknown; error?: unknown; threw?: string }

async function probe(label: string, fn: () => Promise<unknown>): Promise<Probe> {
  try {
    const r = (await fn()) as { response?: { status?: number }; data?: unknown; error?: unknown }
    return { label, status: r?.response?.status, ok: r?.error === undefined && r?.data !== undefined, data: r?.data, error: r?.error }
  } catch (e) {
    return { label, ok: false, threw: e instanceof Error ? e.message : String(e) }
  }
}

function summarize(p: Part): Record<string, unknown> {
  const base: Record<string, unknown> = { id: p.id, type: p.type }
  if (p.type === "text") return { ...base, text: (p as TextPart).text.slice(0, 60) }
  if (p.type === "reasoning") return { ...base, text: (p as ReasoningPart).text.slice(0, 60) }
  if (p.type === "tool") {
    const t = p as ToolPart
    return {
      ...base,
      tool: t.tool,
      callID: t.callID,
      status: t.state.status,
      output: t.state.status === "completed" ? t.state.output.slice(0, 60) : undefined,
    }
  }
  if (p.type === "step-finish") return { ...base, tokens: (p as { tokens?: unknown }).tokens }
  return base
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

function dump(label: string, entries: Entry[]): void {
  console.log(`\n[smoke] ${label}: ${entries.length} mensajes`)
  for (const m of entries) {
    console.log(`  msg ${m.info.id} (${m.info.role}) — ${m.parts.length} partes`)
    m.parts.forEach((p, i) => console.log(`    [${i}]`, JSON.stringify(summarize(p))))
  }
}

async function main(): Promise<void> {
  console.log(`[smoke] server=${baseUrl} dir=${directory}`)

  const created = await client.session.create({ directory, title: "smoke-part-update" })
  if (created.error || !created.data) {
    console.error("[smoke] create failed", created.error)
    process.exit(1)
  }
  const sessionID = created.data.id
  console.log(`[smoke] session=${sessionID}`)

  try {
    // ---- Turno 1: forzar tool call (variant high para intentar reasoning) ----
    const res = await withTimeout(
      client.session.prompt({ sessionID, directory, variant: "high", parts: [{ type: "text", text: TURN1 }] }),
      240_000,
      "turn1",
    )
    if (res.error || !res.data) {
      console.error("[smoke] prompt failed", res.error)
      return
    }
    let entries = await allMessages(sessionID)
    dump("TURNO 1 (todos los mensajes)", entries)

    const allParts = entries.flatMap((m) => m.parts.map((p) => ({ p, messageID: m.info.id })))
    const textRef = allParts.find((x) => x.p.type === "text")
    const reasoningRef = allParts.find((x) => x.p.type === "reasoning")
    const toolRef = allParts.find((x) => x.p.type === "tool")
    const stepFinishRef = allParts.find((x) => x.p.type === "step-finish")
    const targetMessageID = (textRef ?? allParts[0])?.messageID

    const results: Probe[] = []
    const upd = (messageID: string, partID: string, part: Part) =>
      client.part.update({ sessionID, messageID, partID, directory, part })

    // A. TextPart: reescribir text
    results.push(
      textRef
        ? await probe("A text.update.text", () => upd(textRef.messageID, textRef.p.id, { ...(textRef.p as TextPart), text: "REWRITTEN-TEXT" }))
        : { label: "A text.update.text", ok: false, threw: "no text part" },
    )

    // B. ReasoningPart: reescribir text (o crear uno y reescribirlo)
    if (reasoningRef) {
      results.push(
        await probe("B reasoning.update.text", () =>
          upd(reasoningRef.messageID, reasoningRef.p.id, { ...(reasoningRef.p as ReasoningPart), text: "REWRITTEN-REASONING" }),
        ),
      )
    } else if (targetMessageID) {
      const now = Date.now()
      const fake: ReasoningPart = {
        id: "prt_smoke_reasoning", sessionID, messageID: targetMessageID, type: "reasoning",
        text: "created-by-upsert", time: { start: now - 1000, end: now },
      }
      const create = await probe("B reasoning.create(upsert)", () => upd(targetMessageID, fake.id, fake))
      results.push(create)
      results.push(
        await probe("B reasoning.update.text", () =>
          upd(targetMessageID, fake.id, { ...fake, text: "REWRITTEN-REASONING" }),
        ),
      )
    }

    // C. ToolPart: reescribir state.output
    if (toolRef && toolRef.p.type === "tool" && toolRef.p.state.status === "completed") {
      const t = toolRef.p as ToolPart
      results.push(
        await probe("C tool.update.state.output", () =>
          upd(toolRef.messageID, t.id, { ...t, state: { ...t.state, output: "REWRITTEN-TOOL-OUTPUT" } }),
        ),
      )
    } else {
      results.push({ label: "C tool.update.state.output", ok: false, threw: `no completed tool part (${toolRef?.p.type === "tool" ? toolRef.p.state.status : "none found"})` })
    }

    // D. Cambio de type: text -> reasoning
    if (textRef) {
      const mutated = { ...(textRef.p as TextPart), type: "reasoning" as const, time: { start: Date.now() - 1000, end: Date.now() } }
      results.push(await probe("D text.update.type->reasoning", () => upd(textRef.messageID, textRef.p.id, mutated as unknown as Part)))
    }

    // E. UPSERT: crear una parte nueva con id arbitrario
    if (targetMessageID) {
      const injected: Part = { id: "prt_smoke_injected", sessionID, messageID: targetMessageID, type: "text", text: "INJECTED-PART" } as Part
      results.push(await probe("E upsert.create.newPart", () => upd(targetMessageID, injected.id, injected)))
    }

    // F. messageID inexistente
    if (textRef) {
      results.push(await probe("F wrong.messageID", () => upd("msg_does_not_exist", textRef.p.id, { ...(textRef.p as TextPart) })))
    }

    // G. step-finish: tocar el accounting (tokens.input falso)
    if (stepFinishRef && stepFinishRef.p.type === "step-finish") {
      const sf = stepFinishRef.p as Extract<Part, { type: "step-finish" }>
      results.push(
        await probe("G step-finish.tamper.tokens", () =>
          upd(stepFinishRef.messageID, sf.id, { ...sf, tokens: { ...sf.tokens, input: 1, output: 1 } }),
        ),
      )
    }

    // H. delete de la parte inyectada y de una inexistente
    if (targetMessageID) {
      results.push(await probe("H part.delete.injected", () => client.part.delete({ sessionID, messageID: targetMessageID, partID: "prt_smoke_injected", directory })))
      results.push(await probe("H part.delete.nonexistent", () => client.part.delete({ sessionID, messageID: targetMessageID, partID: "prt_never_existed", directory })))
    }

    console.log("\n[smoke] RESULTS:")
    for (const r of results) {
      console.log(JSON.stringify({ label: r.label, status: r.status, ok: r.ok, data: r.data ?? undefined, error: r.error ?? undefined, threw: r.threw }))
    }

    // ---- Test clave: ¿una parte inyectada llega al modelo en el próximo turno? ----
    if (targetMessageID) {
      const secret: Part = { id: "prt_smoke_secret", sessionID, messageID: targetMessageID, type: "text", text: "The launch code is BANANA-77." } as Part
      const inject = await probe("I inject.secret", () => upd(targetMessageID, secret.id, secret))
      console.log("\n[smoke] inject secret:", JSON.stringify(inject))

      const t2 = await withTimeout(
        client.session.prompt({ sessionID, directory, parts: [{ type: "text", text: TURN2 }] }),
        240_000,
        "turn2",
      )
      const reply = t2.data?.parts?.filter((p) => p.type === "text").map((p) => (p as TextPart).text).join(" | ")
      console.log("\n[smoke] TURNO 2 reply:", JSON.stringify(reply))
      console.log("[smoke] VERDICT inject-reaches-model:", reply?.includes("BANANA-77") ? "YES" : "NO")

      entries = await allMessages(sessionID)
      dump("TURNO 2 (todos los mensajes)", entries)
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
