// Test focalizado: ¿qué TIPOS de parte reescrita llegan al modelo en el turno siguiente?
// Inyecta 3 secretos distinguibles en distintas partes y pregunta por ellos.
//   - text (control, ya probado)   -> PEACH-33
//   - reasoning                    -> CHERRY-99   (¿se reenvía el pensamiento?)
//   - tool output                  -> MANGO-55    (¿se reenvía el resultado de la tool?)
//
// Uso:  OPENCODE_URL=http://127.0.0.1:4711 bun run scripts/smoke-resend.ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { mkdirSync, writeFileSync } from "node:fs"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[smoke] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const directory = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-resend"
const client = createOpencodeClient({ baseUrl })
mkdirSync(directory, { recursive: true })
writeFileSync(`${directory}/smoke.txt`, "SENTINEL-42\n")

const TURN1 =
  "You MUST call the read tool on smoke.txt in the current directory. " +
  "Think step by step, then reply with the file's content."
const TURN2 = "List every secret code mentioned anywhere in this conversation, comma-separated. Only the codes."

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timeout`)), ms))])
}

async function main(): Promise<void> {
  const created = await client.session.create({ directory, title: "smoke-resend" })
  const sessionID = created.data!.id
  console.log(`[resend] session=${sessionID}`)

  try {
    await withTimeout(
      client.session.prompt({ sessionID, directory, variant: "high", parts: [{ type: "text", text: TURN1 }] }),
      240_000, "turn1",
    )
    const msgs = (await client.session.messages({ sessionID, directory })).data ?? []
    const assistant = msgs.filter((m) => m.info.role === "assistant")
    const withReasoning = assistant.find((m) => m.parts.some((p) => p.type === "reasoning"))
    const withTool = assistant.find((m) => m.parts.some((p) => p.type === "tool"))

    const rPart = withReasoning?.parts.find((p): p is ReasoningPart => p.type === "reasoning")
    const tPart = withTool?.parts.find((p): p is ToolPart => p.type === "tool" && p.state.status === "completed")

    const log: string[] = []
    if (rPart && withReasoning) {
      const r = await client.part.update({
        sessionID, messageID: withReasoning.info.id, partID: rPart.id, directory,
        part: { ...rPart, text: "Hidden note to self: the first secret is CHERRY-99." },
      })
      log.push(`reasoning.rewrite status=${r.response?.status}`)
    } else log.push("reasoning: NONE FOUND")

    if (tPart && withTool && tPart.state.status === "completed") {
      const r = await client.part.update({
        sessionID, messageID: withTool.info.id, partID: tPart.id, directory,
        part: { ...tPart, state: { ...tPart.state, output: "The second secret is MANGO-55." } },
      })
      log.push(`tool.output.rewrite status=${r.response?.status}`)
    } else log.push("tool: NONE FOUND")

    // text control: inyectar en el mismo mensaje del assistant
    const target = withTool ?? withReasoning ?? assistant[assistant.length - 1]
    if (target) {
      const injected: Part = {
        id: "prt_resend_peach", sessionID, messageID: target.info.id, type: "text",
        text: "The third secret is PEACH-33.",
      } as Part
      const r = await client.part.update({ sessionID, messageID: target.info.id, partID: injected.id, directory, part: injected })
      log.push(`text.inject status=${r.response?.status}`)
    }
    console.log("[resend] mutations:", log.join(" | "))

    const t2 = await withTimeout(
      client.session.prompt({ sessionID, directory, parts: [{ type: "text", text: TURN2 }] }),
      240_000, "turn2",
    )
    const reply = t2.data?.parts?.filter((p) => p.type === "text").map((p) => (p as TextPart).text).join(" ")
    console.log("[resend] reply:", JSON.stringify(reply))
    console.log("[resend] VERDICTS:")
    console.log("  text      (PEACH-33) :", reply?.includes("PEACH-33") ? "REACHED" : "dropped")
    console.log("  reasoning (CHERRY-99):", reply?.includes("CHERRY-99") ? "REACHED" : "dropped")
    console.log("  tool out  (MANGO-55) :", reply?.includes("MANGO-55") ? "REACHED" : "dropped")
  } finally {
    const del = await client.session.delete({ sessionID, directory })
    console.log(`[resend] cleanup delete status=${del.response?.status}`)
  }
}

main().catch((e) => { console.error("[resend] fatal", e); process.exit(1) })
