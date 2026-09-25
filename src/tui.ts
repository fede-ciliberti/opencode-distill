// Entry del plugin TUI: registra los dos comandos en la paleta y el binding
// opcional. Toda la lógica vive en `flow.ts`/`pure.ts`; acá solo hay
// registro y adaptadores finos api → FlowPorts (sin casts, sin JSX).
//
// Convenciones: copy de UI en inglés, comentarios en español rioplatense.

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Part } from "@opencode-ai/sdk/v2"
import { runDistillFlow, runRestoreFlow } from "./flow.js"
import { appendPlanned, appendStatus, latestTrace, readTraces } from "./journal.js"
import type { FlowPorts, PartWriteOutcome } from "./ports.js"
import type { PartLike } from "./pure.js"

const PLUGIN_ID = "opencode-distill"
const COMMAND_DISTILL = "distill-session-stretch"
const COMMAND_RESTORE = "restore-distill"

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

// --- Adaptador PartLike → Part del SDK (sin casts, sin JSX) -------------
// Truco: el spread de `object` produce `{}` en TS (asignable a Record),
// pero copia todas las props enumerables en runtime — soundness sin casts.

function shallowRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) return { ...value }
  return {}
}

function shallowTime(value: unknown): { start: number; end: number; compacted?: number } {
  if (typeof value === "object" && value !== null) return { start: 0, end: 0, ...value }
  return { start: 0, end: 0 }
}

export function toSdkPart(part: PartLike): Part {
  if (part.type === "text") {
    return {
      id: part.id,
      sessionID: part.sessionID,
      messageID: part.messageID,
      type: "text",
      text: part.text ?? "",
      synthetic: part.synthetic,
      metadata: part.metadata !== undefined ? { ...part.metadata } : undefined,
    }
  }
  if (part.type === "reasoning") {
    return {
      id: part.id,
      sessionID: part.sessionID,
      messageID: part.messageID,
      type: "reasoning",
      text: part.text ?? "",
      metadata: part.metadata !== undefined ? { ...part.metadata } : undefined,
      time: { start: 0 },
    }
  }
  // tool (o cualquier otro tipo — tratamos como tool, el único allowlist restante)
  const extra: Record<string, unknown> = { ...part }
  const state = part.state
  const stateExtra: Record<string, unknown> = state !== undefined ? { ...state } : {}
  const status = state?.status

  // Preservar campos del state original que PartLike no declara pero el
  // runtime lleva (el flow hace spread del original: {...original, state: {...}}).
  const preservedInput = shallowRecord(stateExtra.input)
  const preservedTime = shallowTime(stateExtra.time)
  const preservedStateMetadata = shallowRecord(stateExtra.metadata)
  const preservedTitle = typeof stateExtra.title === "string" ? stateExtra.title : ""

  if (status === "error") {
    return {
      id: part.id,
      sessionID: part.sessionID,
      messageID: part.messageID,
      type: "tool",
      callID: typeof extra.callID === "string" ? extra.callID : "",
      tool: typeof extra.tool === "string" ? extra.tool : "",
      state: {
        status: "error",
        input: preservedInput,
        error: state?.error ?? "",
        metadata: preservedStateMetadata,
        time: preservedTime,
      },
      metadata: part.metadata !== undefined ? { ...part.metadata } : undefined,
    }
  }

  // default: completed (el flow solo actualiza tools en TOOL_DONE_STATUSES)
  return {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: "tool",
    callID: typeof extra.callID === "string" ? extra.callID : "",
    tool: typeof extra.tool === "string" ? extra.tool : "",
    state: {
      status: "completed",
      input: preservedInput,
      output: state?.output ?? "",
      title: preservedTitle,
      metadata: preservedStateMetadata,
      time: preservedTime,
    },
    metadata: part.metadata !== undefined ? { ...part.metadata } : undefined,
  }
}

// --- Adaptador api → FlowPorts ------------------------------------------
// El store del TUI separa mensajes y partes; MessageLike los lleva juntos.
// Mergueamos con un spread + api.state.part. El server devuelve newest-first;
// el flow aplica toAscending, así que devolvemos tal cual (el flow revierte).

function adapt(api: TuiPluginApi): FlowPorts {
  const selectAvailable = typeof api.ui.DialogSelect === "function"
  return {
    selectAvailable,
    listStateMessages(sessionID) {
      const messages = api.state.session.messages(sessionID)
      return messages.map((msg) => ({
        ...msg,
        parts: api.state.part(msg.id),
      }))
    },

    async fetchServerMessages(sessionID, limit) {
      const result = await api.client.session.messages({ sessionID, limit })
      if (result.error !== undefined) throw result.error
      const data = result.data ?? []
      return data.map((entry) => ({
        info: { ...entry.info, parts: entry.parts },
        parts: entry.parts,
      }))
    },

    readParts(messageID) {
      return api.state.part(messageID)
    },

    readStateStatus(sessionID) {
      return api.state.session.status(sessionID)
    },

    async fetchServerStatus() {
      const result = await api.client.session.status({ directory: api.state.path.directory })
      if (result.error !== undefined) throw result.error
      return result.data ?? {}
    },

    async updatePart(args) {
      try {
        const result = await api.client.part.update({
          sessionID: args.sessionID,
          messageID: args.messageID,
          partID: args.partID,
          directory: args.directory,
          part: toSdkPart(args.part),
        })
        if (result.error !== undefined) {
          return { ok: false, error: result.error, status: result.response?.status } satisfies PartWriteOutcome
        }
        return { ok: true } satisfies PartWriteOutcome
      } catch (error: unknown) {
        return { ok: false, error } satisfies PartWriteOutcome
      }
    },

    async deletePart(args) {
      try {
        const result = await api.client.part.delete({
          sessionID: args.sessionID,
          messageID: args.messageID,
          partID: args.partID,
          directory: args.directory,
        })
        if (result.error !== undefined) {
          return { ok: false, error: result.error, status: result.response?.status } satisfies PartWriteOutcome
        }
        return { ok: true } satisfies PartWriteOutcome
      } catch (error: unknown) {
        return { ok: false, error } satisfies PartWriteOutcome
      }
    },

    async createScratch(directory, title) {
      const result = await api.client.session.create({ directory, title })
      if (result.error !== undefined) throw result.error
      const data = result.data
      if (data === undefined) throw new Error("session.create returned no data")
      return data.id
    },

    async promptScratch(sessionID, directory, text) {
      const result = await api.client.session.prompt({
        sessionID,
        directory,
        parts: [{ type: "text", text }],
      })
      if (result.error !== undefined) throw result.error
      const data = result.data
      if (data === undefined) throw new Error("session.prompt returned no data")
      let textContent = ""
      for (const p of data.parts) {
        if (p.type === "text") {
          textContent += p.text
        }
      }
      return {
        text: textContent,
        model: { providerID: data.info.providerID, modelID: data.info.modelID },
      }
    },

    async deleteScratch(sessionID, directory) {
      const result = await api.client.session.delete({ sessionID, directory })
      if (result.error !== undefined) throw result.error
    },

    appendPlanned(entry, ts) {
      return appendPlanned(api.state.path.directory, entry, ts)
    },

    appendStatus(sessionID, ts, status, at) {
      return appendStatus(api.state.path.directory, sessionID, ts, status, at)
    },

    readTraces(sessionID) {
      return readTraces(api.state.path.directory, sessionID)
    },

    latestTrace(sessionID) {
      return latestTrace(api.state.path.directory, sessionID)
    },

    confirmDialog(title, message, onConfirm, onCancel) {
      api.ui.dialog.setSize("medium")
      api.ui.dialog.replace(() => api.ui.DialogConfirm({ title, message, onConfirm, onCancel }))
    },

    promptDialog(title, placeholder, onValue, onCancel) {
      api.ui.dialog.setSize("medium")
      api.ui.dialog.replace(() => api.ui.DialogPrompt({ title, placeholder, onConfirm: onValue, onCancel }))
    },

    selectDialog(title, options, current, onSelect, onCancel) {
      api.ui.dialog.setSize("medium")
      api.ui.dialog.replace(
        () =>
          api.ui.DialogSelect({
            title,
            options: options.map((o) => ({ title: o.title, value: o.value, description: o.description })),
            current,
            onSelect: (option) => onSelect(option.value),
          }),
        onCancel,
      )
    },

    toast(variant, message) {
      api.ui.toast({ variant, message })
    },

    currentRouteName() {
      return api.route.current.name
    },

    currentSessionID() {
      const current = api.route.current
      if (current.name !== "session") return undefined
      const sessionID = current.params?.sessionID
      return typeof sessionID === "string" ? sessionID : undefined
    },

    readDirectory() {
      return api.state.path.directory
    },

    now() {
      return Date.now()
    },
  }
}

// --- Tipos de registro (subconjunto estructural, testeable sin SDK) -------

/** Comando tal como lo registra el plugin (subconjunto estructural del `Command` real). */
export type PluginCommandSpec = {
  name: string
  title: string
  category: string
  namespace: string
  slashName: string
  desc: string
  enabled: () => boolean
  run: () => void
}

/** Binding tal como lo registra el plugin (subconjunto estructural del `Binding` real). */
export type PluginBindingSpec = {
  key: string
  cmd: string
  desc: string
}

export type PluginLayer = {
  commands?: readonly PluginCommandSpec[]
  bindings?: readonly PluginBindingSpec[]
}

/** Superficie mínima del `api` que necesita el registro (permite tests sin casts). */
export type PluginRegistrationApi = {
  keymap: { registerLayer(layer: PluginLayer): unknown }
  route: { current: { name: string } }
}

// --- Registro de comandos y binding (separado del entry para testear puro) ---

/** Registra los dos comandos de paleta y el binding opcional. */
export function registerPlugin(
  registration: PluginRegistrationApi,
  runDistill: () => void,
  runRestore: () => void,
  options: { keybind?: unknown } | undefined,
): void {
  const keybind = options?.keybind

  registration.keymap.registerLayer({
    commands: [
      {
        name: COMMAND_DISTILL,
        title: "Distill session stretch",
        category: "Plugin",
        namespace: "palette",
        slashName: "distill",
        desc: "Rewrite a derailed stretch into a compact distillate (files are NOT touched)",
        enabled: () => registration.route.current.name === "session",
        run: runDistill,
      },
      {
        name: COMMAND_RESTORE,
        title: "Restore last distill",
        category: "Plugin",
        namespace: "palette",
        slashName: "distill-restore",
        desc: "Undo a distillation from its disk trace",
        enabled: () => registration.route.current.name === "session",
        run: runRestore,
      },
    ],
  })

  if (isNonEmptyString(keybind)) {
    registration.keymap.registerLayer({
      bindings: [{ key: keybind, cmd: COMMAND_DISTILL, desc: "Distill session stretch" }],
    })
  }
}

// --- Entry del plugin ---

const tui: TuiPlugin = async (api, options) => {
  registerPlugin(
    api,
    () => runDistillFlow(adapt(api)),
    () => runRestoreFlow(adapt(api)),
    options,
  )
}

export default { id: PLUGIN_ID, tui }