// Instrumento objetivo: ¿el ReasoningPart cuenta en el contexto del turno siguiente?
// Mide tokens.input del turno 2 en 3 sesiones idénticas, salvo una parte inyectada:
//   A control | B reasoning grande | C text grande (control positivo del instrumento)
// Si B-A ≈ 0 -> reasoning NO se reenvía. Si C-A ≈ tamaño del text -> el instrumento detecta.
// Uso:  OPENCODE_URL=http://127.0.0.1:4711 bun run scripts/smoke-reasoning-tokens.ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part, ReasoningPart, TextPart } from "@opencode-ai/sdk/v2"
import { mkdirSync } from "node:fs"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[smoke] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const directory = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-tokens"
const client = createOpencodeClient({ baseUrl })
mkdirSync(directory, { recursive: true })

const FILLER = "filler ".repeat(2000) // ~3.5k tokens aprox

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timeout`)), ms))])
}

function inputTokens(entries: Array<{ info: { role: string }; parts: Part[] }>): number | undefined {
  const assistants = entries.filter((m) => m.info.role === "assistant")
  const last = assistants[assistants.length - 1]
  const sf = last?.parts.find((p) => p.type === "step-finish")
  if (sf && sf.type === "step-finish") return sf.tokens.input
  return undefined
}

async function run(label: string, inject: "none" | "reasoning" | "text"): Promise<number | undefined> {
  const created = await client.session.create({ directory, title: `smoke-tokens-${label}` })
  const sessionID = created.data!.id
  try {
    await withTimeout(
      client.session.prompt({ sessionID, directory, parts: [{ type: "text", text: "Say OK." }] }),
      180_000, "turn1",
    )
    const after1 = ((await client.session.messages({ sessionID, directory })).data ?? []) as Array<{ info: { id: string; role: string }; parts: Part[] }>
    const lastAssistant = after1.filter((m) => m.info.role === "assistant").pop()
    if (!lastAssistant) throw new Error("no assistant message")

    if (inject === "reasoning") {
      const part: ReasoningPart = {
        id: "prt_big_reasoning", sessionID, messageID: lastAssistant.info.id, type: "reasoning",
        text: FILLER, time: { start: Date.now() - 1000, end: Date.now() },
      }
      await client.part.update({ sessionID, messageID: lastAssistant.info.id, partID: part.id, directory, part })
    } else if (inject === "text") {
      const part = { id: "prt_big_text", sessionID, messageID: lastAssistant.info.id, type: "text", text: FILLER } as Part
      await client.part.update({ sessionID, messageID: lastAssistant.info.id, partID: part.id, directory, part })
    }

    await withTimeout(
      client.session.prompt({ sessionID, directory, parts: [{ type: "text", text: "Reply with the single word OK." }] }),
      180_000, "turn2",
    )
    const after2 = ((await client.session.messages({ sessionID, directory })).data ?? []) as Array<{ info: { role: string }; parts: Part[] }>
    return inputTokens(after2)
  } finally {
    await client.session.delete({ sessionID, directory })
  }
}

async function main(): Promise<void> {
  console.log(`[tokens] server=${baseUrl} filler≈${FILLER.length} chars`)
  const a = await run("control", "none")
  const b = await run("reasoning", "reasoning")
  const c = await run("text", "text")
  console.log(`[tokens] turn2 input — A(control)=${a} B(+reasoning)=${b} C(+text)=${c}`)
  if (a === undefined || b === undefined || c === undefined) {
    console.log("[tokens] inconclusive: falta step-finish/tokens")
    return
  }
  const dReason = b - a
  const dText = c - a
  console.log(`[tokens] delta B-A (reasoning) = ${dReason}`)
  console.log(`[tokens] delta C-A (text)      = ${dText}`)
  console.log(`[tokens] instrument check: text delta should be large -> ${dText > 1000 ? "OK (detecta reenvío)" : "FALLA (no detecta)"}`)
  console.log(`[tokens] VERDICT reasoning-reaches-context: ${dReason > 1000 ? "REACHED" : "DROPPED"}`)
}

main().catch((e) => { console.error("[tokens] fatal", e); process.exit(1) })
