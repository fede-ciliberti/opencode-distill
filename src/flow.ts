import { mkdirSync } from "node:fs"
import {
  buildBudget,
  buildDistillPrompt,
  buildTranscript,
  parseDistillOutput,
  userRequestFor,
} from "./distill.js"
import {
  buildRestoreOps,
  intersectingTraces,
  pristineReconstruct,
} from "./journal.js"
import type { FlowPorts } from "./ports.js"
import {
  buildConfirmMessage,
  buildEstimates,
  buildReportToast,
  buildRestoreConfirmMessage,
  buildRewritePlan,
  buildStretchOptions,
  buildTypeBreakdown,
  buildTypeOptions,
  findCompactionBoundary,
  mapUpdateError,
  parseTypeSpec,
  partHash,
  selectStretch,
  selectedChars,
  simulatePlan,
  snapshotForTrace,
} from "./pure.js"
import type { MessageLike, PartLike } from "./pure.js"

const distillMutex = new Set<string>()

export function __resetDistillMutexForTests(): void {
  distillMutex.clear()
}

async function resolveStatus(
  ports: FlowPorts,
  sessionID: string,
): Promise<import("./ports.js").SessionStatusLike | undefined> {
  const local = ports.readStateStatus(sessionID)
  if (local !== undefined) return local
  try {
    const map = await ports.fetchServerStatus()
    return map[sessionID]
  } catch {
    return undefined
  }
}

function isBusyStatus(
  status: import("./ports.js").SessionStatusLike | undefined,
): boolean {
  return status?.type === "busy" || status?.type === "retry"
}

function toAscending(
  serverMessages: readonly import("./ports.js").ServerMessage[],
): readonly MessageLike[] {
  return [...serverMessages].reverse().map((entry) => entry.info)
}

function selectAsync<T>(
  ports: FlowPorts,
  title: string,
  options: readonly import("./ports.js").SelectOption<T>[],
  current: T | undefined,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    ports.selectDialog(title, options, current, (value) => resolve(value), () => resolve(undefined))
  })
}

function confirmAsync(
  ports: FlowPorts,
  title: string,
  message: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    ports.confirmDialog(title, message, () => resolve(true), () => resolve(false))
  })
}

function promptAsync(
  ports: FlowPorts,
  title: string,
  placeholder: string,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    ports.promptDialog(title, placeholder, (value) => resolve(value), () => resolve(undefined))
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error as Error)
      },
    )
  })
}

export function runDistillFlow(ports: FlowPorts): void {
  void (async () => {
    const route = ports.currentRouteName()
    if (route !== "session") {
      ports.toast("info", "Open a session first")
      return
    }
    const sessionID = ports.currentSessionID()
    if (sessionID === undefined || sessionID === "") {
      ports.toast("info", "Open a session first")
      return
    }
    if (distillMutex.has(sessionID)) {
      ports.toast("info", "A distillation is already running for this session")
      return
    }
    distillMutex.add(sessionID)
    try {
      await executeDistillFlow(ports, sessionID)
    } finally {
      distillMutex.delete(sessionID)
    }
  })()
}

async function executeDistillFlow(ports: FlowPorts, sessionID: string): Promise<void> {
  let stateMessages = ports.listStateMessages(sessionID)
  let serverMessages: readonly import("./ports.js").ServerMessage[] | undefined

  if (stateMessages.length === 0) {
    try {
      const fetched = await ports.fetchServerMessages(sessionID, 50)
      serverMessages = fetched
      if (fetched.length > 0) stateMessages = toAscending(fetched) as MessageLike[] as typeof stateMessages
    } catch {
      // keep empty, will be handled below
    }
  }

  if (stateMessages.length === 0) {
    ports.toast("info", "No messages to distill")
    return
  }

  const boundary = findCompactionBoundary(stateMessages)
  const stretchOptions = buildStretchOptions(stateMessages, boundary)
  const allStretchOptions = [...stretchOptions.presets, ...stretchOptions.rows]

  const stretchSpec = await selectAsync(ports, "Select stretch to distill", allStretchOptions.map((o) => ({ title: o.title, value: o.value, description: o.description })), undefined)
  if (stretchSpec === undefined) return

  let finalSpec = stretchSpec
  const isRowPick =
    stretchSpec.kind === "range" &&
    stretchOptions.rows.some(
      (r) => r.value.kind === "range" && (r.value as { firstID: string }).firstID === (stretchSpec as { firstID: string }).firstID,
    )
  if (isRowPick) {
    const lastRow = stretchOptions.rows[stretchOptions.rows.length - 1]
    const endSpec = await selectAsync(
      ports,
      "Select end of stretch",
      allStretchOptions.map((o) => ({ title: o.title, value: o.value, description: o.description })),
      lastRow?.value,
    )
    if (endSpec === undefined) return
    if (endSpec.kind === "range" && finalSpec.kind === "range") {
      finalSpec = { kind: "range", firstID: (finalSpec as { firstID: string }).firstID, lastID: (endSpec as { firstID: string }).firstID }
    } else {
      finalSpec = endSpec
    }
  }

  const typeOptions = buildTypeOptions()
  const typeSelection = await selectAsync(ports, "Select content types", typeOptions.map((o) => ({ title: o.title, value: o.value })), undefined)
  if (typeSelection === undefined) return

  let types: import("./pure.js").TypeFilter
  if (typeof typeSelection === "object" && typeSelection !== null && "custom" in typeSelection && (typeSelection as { custom: boolean }).custom === true) {
    const raw = await promptAsync(ports, "Content types", "e.g. text reasoning tool")
    if (raw === undefined) return
    const parsed = parseTypeSpec(raw)
    if (typeof parsed === "object" && parsed !== null && "kind" in parsed && (parsed as { kind: string }).kind === "invalid") {
      ports.toast("error", "Invalid content types — use: text, reasoning, tool")
      return
    }
    types = parsed as import("./pure.js").TypeFilter
  } else {
    types = typeSelection as import("./pure.js").TypeFilter
  }

  const validation = selectStretch(stateMessages, finalSpec, boundary, types)
  if (!validation.ok) {
    const kind = validation.kind
    let message: string
    if (kind === "stretch-crosses-user-message") message = "Stretch crosses a user message"
    else if (kind === "stretch-behind-compaction") message = "Stretch is behind the compaction boundary"
    else if (kind === "stretch-too-small") message = `Stretch too small to be worth distilling (< 500 chars)`
    else if (kind === "no-distillable-content") message = "No distillable content of the selected types in this stretch"
    else if (kind === "stretch-contains-summary") message = "Stretch contains a compaction summary"
    else if (kind === "stretch-contains-compaction") message = "Stretch contains a compaction part"
    else if (kind === "empty-stretch") message = "Stretch is empty — nothing to distill"
    else if (kind === "not-enough-messages") message = validation.message
    else if (kind === "message-not-found") message = validation.message
    else message = validation.message
    ports.toast("error", message)
    return
  }

  const stretchMessageIDs = validation.messageIDs
  const directory = ports.readDirectory()

  const partsByMessage = new Map<string, readonly PartLike[]>()
  for (const message of stateMessages) {
    if (message.role === "assistant") {
      const parts = serverMessages !== undefined
        ? (serverMessages.find((entry) => entry.info.id === message.id)?.parts ?? ports.readParts(message.id))
        : ports.readParts(message.id)
      partsByMessage.set(message.id, parts)
    }
  }
  for (const messageID of stretchMessageIDs) {
    if (!partsByMessage.has(messageID)) {
      partsByMessage.set(messageID, ports.readParts(messageID))
    }
  }

  const snapshot = snapshotForTrace(
    { sessionID, directory, messageIDs: stretchMessageIDs },
    partsByMessage,
  )

  const tracesResult = ports.readTraces(sessionID)
  if (!tracesResult.ok) {
    ports.toast("error", "Could not read distill traces")
    return
  }
  const intersecting = intersectingTraces(tracesResult.traces, stretchMessageIDs)
  const hasCorrupt = intersecting.some((t) => !t.ok)
  if (hasCorrupt) {
    ports.toast("warning", "A distill trace is corrupted — cannot safely distill this stretch")
    return
  }

  const pristineResult = pristineReconstruct(partsByMessage, tracesResult.traces, stretchMessageIDs)
  if (!pristineResult.ok) {
    ports.toast("warning", "A distill trace is corrupted — cannot safely distill this stretch")
    return
  }
  const pristinePartsMap = pristineResult.pristine
  const pristineParts: PartLike[] = []
  for (const parts of pristinePartsMap.values()) {
    pristineParts.push(...parts)
  }

  const currentStretchParts: PartLike[] = []
  for (const messageID of stretchMessageIDs) {
    currentStretchParts.push(...(partsByMessage.get(messageID) ?? []))
  }
  const beforeChars = selectedChars(currentStretchParts, types)

  ports.toast("info", "Distilling stretch…")

  const ts = ports.now()
  const scratchDir = `/tmp/opencode/distill-${ts}`
  try {
    mkdirSync(scratchDir, { recursive: true })
  } catch {
    // ignore mkdir failure, scratch session will handle
  }

  let scratchSessionID: string | undefined
  let distillate: import("./pure.js").Distillate | undefined
  let rawOutput: string | undefined

  try {
    scratchSessionID = await ports.createScratch(scratchDir, "distill-scratch")
    const transcript = buildTranscript(pristineParts, stretchMessageIDs, types)
    const userRequest = userRequestFor(stateMessages, { sessionID, directory, messageIDs: stretchMessageIDs })
    const budget = buildBudget(beforeChars)
    const prompt = buildDistillPrompt(transcript, userRequest, budget, types)

    const result = await withTimeout(ports.promptScratch(scratchSessionID, scratchDir, prompt), 240_000)
    rawOutput = result.text
    const model = result.model

    const parsed = parseDistillOutput(rawOutput, stretchMessageIDs, budget)
    if (!parsed.ok) {
      ports.toast("error", "Distiller returned invalid output — nothing was changed")
      return
    }
    distillate = { ...parsed.distillate, model }
  } catch {
    if (rawOutput === undefined) {
      ports.toast("error", "Distiller returned invalid output — nothing was changed")
    } else {
      ports.toast("error", "Distiller returned invalid output — nothing was changed")
    }
    return
  } finally {
    if (scratchSessionID !== undefined) {
      try {
        await ports.deleteScratch(scratchSessionID, scratchDir)
      } catch {
        ports.toast("warning", "Could not clean up the scratch session")
      }
    }
  }

  if (distillate === undefined) {
    ports.toast("error", "Distiller returned invalid output — nothing was changed")
    return
  }

  const mutableParts = currentStretchParts.filter(
    (p) => p.type === "text" || p.type === "reasoning" || p.type === "tool",
  )

  let plan: import("./pure.js").RewritePlan
  try {
    plan = buildRewritePlan(
      { sessionID, directory, messageIDs: stretchMessageIDs },
      mutableParts,
      distillate,
      types,
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    ports.toast("error", `Internal validation failed — nothing was changed: ${message}`)
    return
  }

  const userMessageIDs = new Set<string>()
  for (const message of stateMessages) {
    if (message.role === "user") userMessageIDs.add(message.id)
  }

  const simResult = simulatePlan(plan, partsByMessage, {
    originals: [...snapshot.originals],
    userMessageIDs,
  })
  if (!simResult.ok) {
    ports.toast("error", "Internal validation failed — nothing was changed")
    return
  }

  const afterChars = plan.mass.afterChars
  const breakdown = buildTypeBreakdown(pristineParts, types)
  const charsAfterStretch = (() => {
    let total = 0
    const stretchSet = new Set(stretchMessageIDs)
    let foundStretch = false
    for (const message of stateMessages) {
      if (stretchSet.has(message.id)) foundStretch = true
      else if (foundStretch && message.role === "assistant") {
        const parts = partsByMessage.get(message.id) ?? []
        total += selectedChars([...parts], types)
      }
    }
    return total
  })()
  const estimates = buildEstimates(beforeChars, afterChars, charsAfterStretch, stretchMessageIDs[0] ?? "")
  const range = { firstID: stretchMessageIDs[0] ?? "", lastID: stretchMessageIDs[stretchMessageIDs.length - 1] ?? "" }
  const confirmMessage = buildConfirmMessage(range, stretchMessageIDs.length, breakdown, beforeChars, afterChars, estimates)

  const confirmed = await confirmAsync(ports, "Confirm distillation", confirmMessage)
  if (!confirmed) return

  const reStatus = await resolveStatus(ports, sessionID)
  if (isBusyStatus(reStatus)) {
    ports.toast("warning", "Session is busy — distill aborted before any change")
    return
  }

  const currentMessages = ports.listStateMessages(sessionID)
  let currentServerMessages: readonly import("./ports.js").ServerMessage[] | undefined
  if (currentMessages.length === 0) {
    try {
      const fetched = await ports.fetchServerMessages(sessionID, 50)
      currentServerMessages = fetched
    } catch {
      // keep empty
    }
  }
  const effectiveMessages = currentMessages.length > 0 ? currentMessages : (currentServerMessages ? toAscending(currentServerMessages) as MessageLike[] as typeof currentMessages : currentMessages)

  if (effectiveMessages.length !== stateMessages.length) {
    ports.toast("warning", "The conversation changed during distillation — nothing was changed")
    return
  }
  for (let i = 0; i < effectiveMessages.length; i++) {
    if (effectiveMessages[i]?.id !== stateMessages[i]?.id) {
      ports.toast("warning", "The conversation changed during distillation — nothing was changed")
      return
    }
  }

  const currentPartsByMessage = new Map<string, readonly PartLike[]>()
  for (const messageID of stretchMessageIDs) {
    const parts = ports.readParts(messageID)
    currentPartsByMessage.set(messageID, parts)
  }

  for (const { part } of snapshot.originals) {
    const currentParts = currentPartsByMessage.get(part.messageID) ?? []
    const current = currentParts.find((p) => p.id === part.id)
    if (current === undefined) {
      ports.toast("warning", "The conversation changed during distillation — nothing was changed")
      return
    }
    if (partHash(current) !== partHash(part)) {
      ports.toast("warning", "The conversation changed during distillation — nothing was changed")
      return
    }
  }

  const traceEntry: import("./pure.js").TraceEntry = {
    version: 1,
    sessionID,
    createdAt: ts,
    stretch: [...stretchMessageIDs],
    originals: [...snapshot.originals],
    createdPartIDs: plan.ops.filter((op) => op.kind === "update" && (op.part.id.startsWith("prt_distill_") || op.part.id.startsWith("prt_stub_"))).map((op) => (op as { kind: "update"; part: PartLike }).part.id),
    plan: [...plan.ops],
    distillate,
    status: "planned",
  }

  const plannedResult = ports.appendPlanned(traceEntry, ts)
  if (!plannedResult.ok) {
    ports.toast("error", `Could not write trace — nothing was changed: ${plannedResult.message}`)
    return
  }

  const executingResult = ports.appendStatus(sessionID, ts, "executing", ports.now())
  void executingResult

  let hadWrites = false
  const updates = plan.ops.filter((op) => op.kind === "update")
  const deletes = plan.ops.filter((op) => op.kind === "delete")

  for (const op of updates) {
    if (op.kind !== "update") continue
    const result = await ports.updatePart({
      sessionID,
      messageID: op.messageID,
      partID: op.part.id,
      directory,
      part: op.part,
    })
    if (!result.ok) {
      const mapped = mapUpdateError(result.error, result.status)
      if (hadWrites) {
        ports.appendStatus(sessionID, ts, "partial", ports.now())
        ports.toast("error", `${mapped.message} — run /distill-restore to undo`)
      } else {
        ports.toast("error", `${mapped.message} — nothing was changed`)
      }
      return
    }
    hadWrites = true
  }

  for (const op of deletes) {
    if (op.kind !== "delete") continue
    const result = await ports.deletePart({
      sessionID,
      messageID: op.messageID,
      partID: op.partID,
      directory,
    })
    if (!result.ok) {
      const mapped = mapUpdateError(result.error, result.status)
      if (hadWrites) {
        ports.appendStatus(sessionID, ts, "partial", ports.now())
        ports.toast("error", `${mapped.message} — run /distill-restore to undo`)
      } else {
        ports.toast("error", `${mapped.message} — nothing was changed`)
      }
      return
    }
    hadWrites = true
  }

  ports.appendStatus(sessionID, ts, "done", ports.now())
  ports.toast("success", buildReportToast(stretchMessageIDs.length, beforeChars, afterChars))
}

// --- Restore flow con selector de trazas (task #15, DEC-4.3/.5 + D4). ---
// Orden: GATE → READ → SELECT → CONFIRM → RE-VALID → PRISTINE GUARD → EXECUTE → REPORT.
// Las corruptas se listan DISABLED (sentinel, jamás matchea un ts real) y no son
// seleccionables; intersectingTraces trata toda corrupta como intersectante
// (fail-closed), así que pristineReconstruct refusea si alguna la toca.

const CORRUPT_OPTION_VALUE = -1

function formatRestoreTitle(ts: number, nMessages: number, status: string): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, "0")
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return `${date} — ${nMessages} messages (${status})`
}

function corruptTitleOf(file: string): string {
  const base = file.split("/").pop() ?? file
  return `${base} (corrupt)`
}

export function runRestoreFlow(ports: FlowPorts): void {
  void (async () => {
    const route = ports.currentRouteName()
    if (route !== "session") {
      ports.toast("info", "Open a session first")
      return
    }
    const sessionID = ports.currentSessionID()
    if (sessionID === undefined || sessionID === "") {
      ports.toast("info", "Open a session first")
      return
    }
    await executeRestoreFlow(ports, sessionID)
  })()
}

async function executeRestoreFlow(ports: FlowPorts, sessionID: string): Promise<void> {
  const gateStatus = await resolveStatus(ports, sessionID)
  if (isBusyStatus(gateStatus)) {
    ports.toast("warning", "Session is busy — try again when it's idle")
    return
  }

  const firstRead = ports.readTraces(sessionID)
  if (!firstRead.ok) {
    ports.toast("error", "Could not read distill traces")
    return
  }
  const traces = firstRead.traces
  if (traces.length === 0) {
    ports.toast("info", "No distill traces for this session")
    return
  }
  if (!traces.some((t) => t.ok)) {
    ports.toast("warning", "All distill traces are corrupted — restore unavailable")
    return
  }

  const options = traces.map((trace) => {
    if (!trace.ok) {
      return { title: corruptTitleOf(trace.file), description: undefined, value: CORRUPT_OPTION_VALUE }
    }
    return {
      title: formatRestoreTitle(trace.ts, trace.entry.stretch.length, trace.status),
      description: [...trace.entry.stretch].join(", "),
      value: trace.ts,
    }
  })
  const latestHealthy = traces.find((t) => t.ok)
  const latestTs = latestHealthy !== undefined && latestHealthy.ok ? latestHealthy.ts : undefined

  const selectedTs = await selectAsync(ports, "Select trace to restore", options, latestTs)
  if (selectedTs === undefined) return

  const chosenFirst = traces.find((t) => t.ok && t.ts === selectedTs)
  if (chosenFirst === undefined || !chosenFirst.ok) {
    ports.toast("warning", "Trace not found — nothing restored")
    return
  }

  const confirmed = await confirmAsync(
    ports,
    "Confirm restore",
    buildRestoreConfirmMessage({ createdAt: chosenFirst.entry.createdAt, stretch: chosenFirst.entry.stretch }),
  )
  if (!confirmed) return

  const reStatus = await resolveStatus(ports, sessionID)
  if (isBusyStatus(reStatus)) {
    ports.toast("warning", "Session is busy — try again when it's idle")
    return
  }
  const secondRead = ports.readTraces(sessionID)
  if (!secondRead.ok) {
    ports.toast("error", "Could not read distill traces")
    return
  }
  const fresh = secondRead.traces.find((t) => t.ok && t.ts === selectedTs)
  if (fresh === undefined || !fresh.ok) {
    ports.toast("warning", "Trace not found — nothing restored")
    return
  }

  const stretchMessageIDs = [...fresh.entry.stretch]
  const partsByMessage = new Map<string, readonly PartLike[]>()
  for (const messageID of stretchMessageIDs) {
    partsByMessage.set(messageID, ports.readParts(messageID))
  }
  const pristineResult = pristineReconstruct(partsByMessage, secondRead.traces, stretchMessageIDs)
  if (!pristineResult.ok) {
    ports.toast("warning", "A related distill trace is corrupted — restore unavailable for this stretch")
    return
  }

  const opsResult = buildRestoreOps(partsByMessage, pristineResult.pristine, stretchMessageIDs)
  if (!opsResult.ok) {
    ports.toast("error", "Restore cannot proceed — nothing was changed")
    return
  }
  const directory = ports.readDirectory()
  const updates = opsResult.ops.filter((op) => op.kind === "update")
  const deletes = opsResult.ops.filter((op) => op.kind === "delete")

  for (const op of updates) {
    if (op.kind !== "update") continue
    const result = await ports.updatePart({
      sessionID,
      messageID: op.messageID,
      partID: op.part.id,
      directory,
      part: op.part,
    })
    if (!result.ok) {
      const mapped = mapUpdateError(result.error, result.status)
      ports.toast("error", `${mapped.message} — Restore incomplete — re-run /distill-restore (it is safe to retry)`)
      return
    }
  }

  for (const op of deletes) {
    if (op.kind !== "delete") continue
    const result = await ports.deletePart({
      sessionID,
      messageID: op.messageID,
      partID: op.partID,
      directory,
    })
    if (!result.ok) {
      const mapped = mapUpdateError(result.error, result.status)
      ports.toast("error", `${mapped.message} — Restore incomplete — re-run /distill-restore (it is safe to retry)`)
      return
    }
  }

  void ports.appendStatus(sessionID, selectedTs, "restored", ports.now())
  ports.toast("success", "Restore complete — original content is back")
}
