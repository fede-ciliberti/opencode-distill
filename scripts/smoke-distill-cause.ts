// Sonda acotada: ¿qué parte del tramo destilado rompe el schema del provider?
// Tres brazos sobre sesiones scratch separadas (mismo modelo gpt-oss-20b):
//   (a) texto plano con id normal en mensaje assistant
//   (b) texto con synthetic:true + metadata distilled
//   (c) tool completed con output stubeado + metadata.preview
// Cada brazo: 1 turno con tool call real → inyección → prompt "OK" →
// informa si el turno siguiente responde o rechaza con ModelMessage[] schema.
// Uso: PORT=4717 LOG=/tmp/opencode/distill-probe.log scripts/run-smoke.sh scripts/smoke-distill-cause.ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { mkdirSync, writeFileSync } from "node:fs"

const baseUrl = process.env.OPENCODE_URL
if (!baseUrl) {
  console.error("[smoke] OPENCODE_URL unset — refusing to run (use scripts/run-smoke.sh)")
  process.exit(1)
}
const baseDir = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-distill-cause"
const client = createOpencodeClient({ baseUrl })
const MODEL = { providerID: "litellm", modelID: process.env.SMOKE_MODEL ?? "gpt-oss-20b" }

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

type Entry = { info: { id: string; role: string; error?: unknown }; parts: Part[] }

async function fetchEntries(sessionID: string, directory: string): Promise<Entry[]> {
  const r = await client.session.messages({ sessionID, directory })
  return ((r.data ?? []) as Entry[]).slice().sort((a, b) => a.info.id.localeCompare(b.info.id))
}

async function setupSession(directory: string, label: string): Promise<{ sessionID: string; assistantID: string; toolPart?: ToolPart }> {
  mkdirSync(directory, { recursive: true })
  writeFileSync(`${directory}/probe.txt`, `PROBE LINE ${label} with plenty of filler text to give the turn some mass `.repeat(20))
  const created = await client.session.create({ directory, title: `smoke-cause-${label}` })
  if (created.error !== undefined || created.data === undefined) throw new Error(`create ${label} failed`)
  const sessionID = created.data.id
  const res = await withTimeout(
    client.session.prompt({
      sessionID,
      directory,
      model: MODEL,
      parts: [{ type: "text", text: "Read the file probe.txt with the read tool, then reply with the word DONE." }],
    }),
    240_000,
    `${label}-setup`,
  )
  if (res.error !== undefined) throw new Error(`${label} setup failed: ${JSON.stringify(res.error)}`)
  const entries = await fetchEntries(sessionID, directory)
  const assistants = entries.filter((e) => e.info.role === "assistant")
  const last = assistants[assistants.length - 1]
  if (last === undefined) throw new Error(`${label}: sin assistant`)
  const tool = last.parts.find((p) => p.type === "tool") as ToolPart | undefined
  console.log(`[cause] ${label}: session=${sessionID} assistant=${last.info.id} parts=${last.parts.map((p) => p.type).join(",")}`)
  return { sessionID, assistantID: last.info.id, toolPart: tool }
}

async function followup(sessionID: string, directory: string, label: string): Promise<string> {
  const res = await withTimeout(
    client.session.prompt({ sessionID, directory, model: MODEL, parts: [{ type: "text", text: "Reply with the single word OK." }] }),
    240_000,
    `${label}-followup`,
  )
  if (res.error !== undefined) return `PROMPT-ERROR ${JSON.stringify(res.error).slice(0, 120)}`
  const entries = await fetchEntries(sessionID, directory)
  const assistants = entries.filter((e) => e.info.role === "assistant")
  const last = assistants[assistants.length - 1]
  const nParts = last?.parts.length ?? -1
  const errMsg = (last?.info.error as { data?: { message?: string } } | undefined)?.data?.message
  const reply = (last?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as TextPart).text)
    .join("|")
    .slice(0, 80)
  if (nParts === 0) return `REJECTED error=${JSON.stringify(errMsg)?.slice(0, 160)}`
  return `OK parts=${nParts} reply=${JSON.stringify(reply)}`
}

async function arm(label: string, inject: (ctx: { sessionID: string; assistantID: string; toolPart?: ToolPart }) => Promise<void>): Promise<void> {
  const directory = `${baseDir}/${label}`
  let sessionID = ""
  try {
    const ctx = await setupSession(directory, label)
    sessionID = ctx.sessionID
    await inject(ctx)
    const verdict = await followup(ctx.sessionID, directory, label)
    console.log(`[cause] ${label}: ${verdict}`)
  } finally {
    if (sessionID !== "") await client.session.delete({ sessionID, directory })
  }
}

async function main(): Promise<void> {
  console.log(`[cause] server=${baseUrl} model=${MODEL.providerID}/${MODEL.modelID}`)

  await arm("a-plain-text", async ({ sessionID, assistantID }) => {
    const part = { id: "prt_cause_plain", sessionID, messageID: assistantID, type: "text", text: "INJECTED PLAIN TEXT" } as Part
    const r = await client.part.update({ sessionID, messageID: assistantID, partID: part.id, directory: `${baseDir}/a-plain-text`, part })
    console.log(`[cause] a inject status=${r.response?.status} error=${JSON.stringify(r.error)?.slice(0, 100)}`)
  })

  await arm("b-synthetic", async ({ sessionID, assistantID }) => {
    const part = {
      id: "prt_distill_cause12",
      sessionID,
      messageID: assistantID,
      type: "text",
      text: "INJECTED SYNTHETIC DISTILLATE",
      synthetic: true,
      metadata: { distilled: true, traceRef: "cause12", types: ["text", "reasoning", "tool"] },
    } as Part
    const r = await client.part.update({ sessionID, messageID: assistantID, partID: part.id, directory: `${baseDir}/b-synthetic`, part })
    console.log(`[cause] b inject status=${r.response?.status} error=${JSON.stringify(r.error)?.slice(0, 100)}`)
  })

  await arm("c-stubbed-tool", async ({ sessionID, assistantID, toolPart }) => {
    const dir = `${baseDir}/c-stubbed-tool`
    let tool: ToolPart | undefined = toolPart
    if (tool === undefined || tool.state.status !== "completed") {
      const now = Date.now()
      const seeded = {
        id: "prt_0d9ca0000001seededTool0001",
        sessionID,
        messageID: assistantID,
        type: "tool",
        tool: "read",
        callID: "call_seeded_1",
        state: {
          status: "completed",
          input: { path: "probe.txt" },
          output: "SEEDED OUTPUT ".repeat(50),
          title: "read probe.txt",
          metadata: {},
          time: { start: now - 1000, end: now },
        },
      } as unknown as Part
      const s = await client.part.update({ sessionID, messageID: assistantID, partID: seeded.id, directory: dir, part: seeded })
      console.log(`[cause] c seed status=${s.response?.status} error=${JSON.stringify(s.error)?.slice(0, 100)}`)
      const entries = await fetchEntries(sessionID, dir)
      const asst = entries.find((e) => e.info.id === assistantID)
      tool = asst?.parts.find((p) => p.type === "tool") as ToolPart | undefined
    }
    if (tool === undefined || tool.state.status !== "completed") {
      console.log("[cause] c: sin tool completed aun tras seed — brazo no aplicable")
      return
    }
    const label = "[distilled] read — see distillate"
    if (tool.state.status !== "completed") {
      console.log("[cause] c: tool cambió de estado — brazo no aplicable")
      return
    }
    const part: Part = {
      ...tool,
      state: { ...tool.state, output: label },
      metadata: { ...(tool.metadata ?? {}), preview: label },
    }
    const r = await client.part.update({ sessionID, messageID: assistantID, partID: part.id, directory: `${baseDir}/c-stubbed-tool`, part })
    console.log(`[cause] c inject status=${r.response?.status} error=${JSON.stringify(r.error)?.slice(0, 100)}`)
  })

  await arm("e-synth-only", async ({ sessionID, assistantID }) => {
    const part = {
      id: "prt_cause_synth",
      sessionID,
      messageID: assistantID,
      type: "text",
      text: "INJECTED SYNTHETIC ONLY",
      synthetic: true,
    } as Part
    const r = await client.part.update({ sessionID, messageID: assistantID, partID: part.id, directory: `${baseDir}/e-synth-only`, part })
    console.log(`[cause] e inject status=${r.response?.status} error=${JSON.stringify(r.error)?.slice(0, 100)}`)
  })

  await arm("f-meta-only", async ({ sessionID, assistantID }) => {
    const part = {
      id: "prt_cause_meta",
      sessionID,
      messageID: assistantID,
      type: "text",
      text: "INJECTED META ONLY",
      metadata: { distilled: true, traceRef: "cause12" },
    } as Part
    const r = await client.part.update({ sessionID, messageID: assistantID, partID: part.id, directory: `${baseDir}/f-meta-only`, part })
    console.log(`[cause] f inject status=${r.response?.status} error=${JSON.stringify(r.error)?.slice(0, 100)}`)
  })

  await arm("g-distill-id-plain", async ({ sessionID, assistantID }) => {
    const part = {
      id: "prt_distill_cause34",
      sessionID,
      messageID: assistantID,
      type: "text",
      text: "INJECTED DISTILL ID PLAIN",
    } as Part
    const r = await client.part.update({ sessionID, messageID: assistantID, partID: part.id, directory: `${baseDir}/g-distill-id-plain`, part })
    console.log(`[cause] g inject status=${r.response?.status} error=${JSON.stringify(r.error)?.slice(0, 100)}`)
  })

  await arm("d-delete-text", async ({ sessionID, assistantID }) => {    const entries = await fetchEntries(sessionID, `${baseDir}/d-delete-text`)
    const asst = entries.find((e) => e.info.id === assistantID)
    const text = asst?.parts.find((p) => p.type === "text")
    if (text === undefined) {
      console.log("[cause] d: sin text — brazo no aplicable")
      return
    }
    const r = await client.part.delete({ sessionID, messageID: assistantID, partID: text.id, directory: `${baseDir}/d-delete-text` })
    console.log(`[cause] d delete status=${r.response?.status} text=${text.id}`)
  })

  console.log("[cause] DONE")
}

main().catch((e) => {
  console.error("[cause] fatal", e)
  process.exit(1)
})
