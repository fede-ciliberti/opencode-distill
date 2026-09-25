// Test aislado: ¿el ReasoningPart reescrito llega al modelo en el turno siguiente?
// Reescribe SOLO el reasoning con un secreto y pregunta por él. Sin distractores.
// Uso:  OPENCODE_URL=http://127.0.0.1:4711 bun run scripts/smoke-reasoning-only.ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part, ReasoningPart, TextPart } from "@opencode-ai/sdk/v2"
import { mkdirSync, writeFileSync } from "node:fs"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[smoke] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const directory = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-reasoning"
const client = createOpencodeClient({ baseUrl })
mkdirSync(directory, { recursive: true })
writeFileSync(`${directory}/smoke.txt`, "SENTINEL-42\n")

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timeout`)), ms))])
}

async function main(): Promise<void> {
  const created = await client.session.create({ directory, title: "smoke-reasoning-only" })
  const sessionID = created.data!.id
  console.log(`[reasoning] session=${sessionID}`)
  try {
    // El reasoning part es no-determinista: reintentar con prompts inductores.
    const prompts = [
      "Think step by step. A bat and a ball cost 1.10 total. The bat costs 1.00 more than the ball. How much is the ball?",
      "Reason carefully step by step: if 5 machines take 5 minutes to make 5 widgets, how long do 100 machines take to make 100 widgets?",
      "Think step by step, use the read tool on smoke.txt, then report its content.",
      "Reason step by step about the pros and cons of tabs vs spaces, then answer.",
    ]
    let withR: { info: { id: string }; parts: Part[] } | undefined
    let rPart: ReasoningPart | undefined
    for (const text of prompts) {
      await withTimeout(
        client.session.prompt({ sessionID, directory, variant: "high", parts: [{ type: "text", text }] }),
        240_000, "turn",
      )
      const msgs = (await client.session.messages({ sessionID, directory })).data ?? []
      const candidates = msgs.filter((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "reasoning"))
      const last = candidates[candidates.length - 1]
      if (last) {
        withR = last
        rPart = last.parts.find((p): p is ReasoningPart => p.type === "reasoning")
        break
      }
    }
    if (!withR || !rPart) {
      console.log("[reasoning] NO reasoning part generated tras 4 intentos — inconclusive")
      return
    }
    const upd = await client.part.update({
      sessionID, messageID: withR.info.id, partID: rPart.id, directory,
      part: { ...rPart, text: "Private note: the magic word is KIWI-11." },
    })
    console.log(`[reasoning] rewrite status=${upd.response?.status}`)

    const t2 = await withTimeout(
      client.session.prompt({ sessionID, directory, parts: [{ type: "text", text: "What is the magic word? Reply with only the word." }] }),
      240_000, "turn2",
    )
    const reply = t2.data?.parts?.filter((p) => p.type === "text").map((p) => (p as TextPart).text).join(" ")
    console.log("[reasoning] reply:", JSON.stringify(reply))
    console.log("[reasoning] VERDICT reasoning-reaches-model:", reply?.includes("KIWI-11") ? "REACHED" : "dropped")
  } finally {
    const del = await client.session.delete({ sessionID, directory })
    console.log(`[reasoning] cleanup delete status=${del.response?.status}`)
  }
}

main().catch((e) => { console.error("[reasoning] fatal", e); process.exit(1) })
