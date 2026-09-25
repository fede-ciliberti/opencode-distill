// Smoke bloqueante Q4: ¿qué devuelve `part.update` / `part.delete` con sesión busy?
// Pregunta que responde (docs/04 Q4):
//   - ¿part.update con sesión busy devuelve 409? ¿qué shape tiene el error?
//   - ¿part.delete ídem? ¿session.messages (lectura) está permitida en busy?
// Alimenta `mapUpdateError` del todo 14 (patrón `mapDeleteError` del hermano).
//
// Uso:  PORT=4715 LOG=/tmp/opencode/distill-smoke-5.log scripts/run-smoke.sh scripts/smoke-busy.ts
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
const directory = process.env.SMOKE_DIR ?? "/tmp/opencode/smoke-busy"
const client = createOpencodeClient({ baseUrl })

mkdirSync(directory, { recursive: true })

const SETUP_TURN = "Reply with exactly: PING"
const LONG_TURN =
  "Write a 500-word essay about the history of lighthouses, in English. " +
  "It must be at least 450 words long. Do not call any tools, just write the essay."
const LONG_MODEL = { providerID: "litellm", modelID: "muse-spark-1.3-contributor" }

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

async function sessionStatus(sessionID: string): Promise<unknown> {
  try {
    const r = await client.session.status({ directory })
    const data = (r as { data?: Record<string, unknown> }).data
    return data?.[sessionID] ?? data ?? { error: (r as { error?: unknown }).error }
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) }
  }
}

async function main(): Promise<void> {
  console.log(`[smoke] server=${baseUrl} dir=${directory}`)

  const created = await client.session.create({ directory, title: "smoke-busy" })
  if (created.error || !created.data) {
    console.error("[smoke] create failed", created.error)
    process.exit(1)
  }
  const sessionID = created.data.id
  console.log(`[smoke] session=${sessionID}`)

  const results: Probe[] = []

  async function waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const s = await sessionStatus(sessionID)
      if (!JSON.stringify(s).includes("busy")) return true
      await new Promise((r) => setTimeout(r, 1000))
    }
    return false
  }

  try {
    const setup = await withTimeout(
      client.session.prompt({ sessionID, directory, model: LONG_MODEL, parts: [{ type: "text", text: SETUP_TURN }] }),
      240_000,
      "setup-turn",
    )
    if ((setup as { error?: unknown }).error) {
      console.error("[smoke] setup prompt failed", (setup as { error?: unknown }).error)
      return
    }
    const entries = await allMessages(sessionID)
    const targetMessageID = entries[0]?.info.id
    if (!targetMessageID) {
      console.error("[smoke] no messages after setup turn — aborting")
      process.exit(1)
    }

    // Dos partes sonda creadas en idle (upsert): una para update, otra para delete.
    const updPart: Part = { id: "prt_busy_probe_update", sessionID, messageID: targetMessageID, type: "text", text: "PROBE-UPDATE-V1" } as Part
    const delPart: Part = { id: "prt_busy_probe_delete", sessionID, messageID: targetMessageID, type: "text", text: "PROBE-DELETE-V1" } as Part
    const upd = (messageID: string, partID: string, part: Part) =>
      client.part.update({ sessionID, messageID, partID, directory, part })
    results.push(await probe("setup upsert prt_busy_probe_update (idle)", () => upd(targetMessageID, updPart.id, updPart)))
    results.push(await probe("setup upsert prt_busy_probe_delete (idle)", () => upd(targetMessageID, delPart.id, delPart)))

    console.log("[smoke] firing long prompt WITHOUT await (promptAsync)…")
    const asyncRes = await client.session.promptAsync({ sessionID, directory, model: LONG_MODEL, parts: [{ type: "text", text: LONG_TURN }] })
    console.log("[smoke] promptAsync response:", JSON.stringify({ status: asyncRes.response?.status, error: asyncRes.error }))
    if (asyncRes.error) {
      console.error("[smoke] promptAsync failed — cannot test busy; aborting busy probes")
      process.exit(1)
    }
    for (let i = 0; i < 20; i++) {
      const s = await sessionStatus(sessionID)
      if (JSON.stringify(s).includes("busy")) break
      await new Promise((r) => setTimeout(r, 500))
    }

    const busyStatus = await sessionStatus(sessionID)
    console.log("[smoke] session.status while probing:", JSON.stringify(busyStatus))
    const looksBusy = JSON.stringify(busyStatus).includes("busy")
    if (!looksBusy) {
      console.log("[smoke] RACE-WARNING: session does not look busy — the prompt may have finished before the probe. Results below may reflect idle, not busy.")
    }

    // (A) part.update de parte existente mientras busy
    results.push(
      await probe("A part.update.existing (busy)", () =>
        upd(targetMessageID, updPart.id, { ...(updPart as TextPart), text: "PROBE-UPDATE-BUSY" } as Part),
      ),
    )
    // (B) part.delete de parte existente mientras busy
    results.push(
      await probe("B part.delete.existing (busy)", () =>
        client.part.delete({ sessionID, messageID: targetMessageID, partID: delPart.id, directory }),
      ),
    )
    // (C) lectura session.messages mientras busy
    results.push(await probe("C session.messages (busy)", () => client.session.messages({ sessionID, directory })))

    console.log("\n[smoke] BUSY RESULTS:")
    for (const r of results.slice(-3)) {
      console.log(JSON.stringify({ label: r.label, status: r.status, ok: r.ok, data: r.data ?? undefined, error: r.error ?? undefined, threw: r.threw }))
    }

    console.log("\n[smoke] awaiting idle (polling session.status)…")
    const becameIdle = await waitForIdle(240_000)
    console.log(`[smoke] waitForIdle → ${becameIdle ? "idle" : "still busy after timeout"}`)
    const idleStatus = await sessionStatus(sessionID)
    console.log("[smoke] session.status after wait:", JSON.stringify(idleStatus))

    results.push(
      await probe("A2 part.update.existing (idle)", () =>
        upd(targetMessageID, updPart.id, { ...(updPart as TextPart), text: "PROBE-UPDATE-IDLE" } as Part),
      ),
    )
    // Re-crear la parte borrada (o re-borrarla si el delete en busy falló) y borrarla en idle.
    results.push(await probe("B2 upsert prt_busy_probe_delete (idle)", () => upd(targetMessageID, delPart.id, delPart)))
    results.push(
      await probe("B3 part.delete.existing (idle)", () =>
        client.part.delete({ sessionID, messageID: targetMessageID, partID: delPart.id, directory }),
      ),
    )
    results.push(await probe("C2 session.messages (idle)", () => client.session.messages({ sessionID, directory })))

    console.log("\n[smoke] FULL TABLE (op × busy/idle → status + error shape):")
    for (const r of results) {
      console.log(JSON.stringify({ label: r.label, status: r.status, ok: r.ok, data: r.data ?? undefined, error: r.error ?? undefined, threw: r.threw }))
    }
    console.log(`\n[smoke] race-note: session looked busy during probe = ${looksBusy}`)
  } finally {
    await waitForIdle(30_000).catch(() => {})
    const del = await client.session.delete({ sessionID, directory })
    console.log(`\n[smoke] cleanup delete status=${del.response?.status}`)
  }
}

main().catch((e) => {
  console.error("[smoke] fatal", e)
  process.exit(1)
})
