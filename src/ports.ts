// Puertos mínimos del plugin: interfaces estructurales chiquitas que el `api`
// real y el SDK satisfacen vía adaptadores finos en `tui.ts`, SIN casts.
// El flow (`flow.ts`) solo conoce estos puertos → testeable con fakes.
//
// Convenciones: copy de UI en inglés, comentarios en español rioplatense.
//
// NOTE: no importa el runtime del SDK acá (solo tipos de pure/journal);
// el factory del client no hace falta en runtime (ver test/contract.test.ts).
import type {
  AppendPlannedResult,
  AppendStatusResult,
  LatestTraceResult,
  ReadTracesResult,
} from "./journal.js"
import type { MessageLike, PartLike, TraceEntry } from "./pure.js"

/** Estado de sesión (forma mínima que consume el plugin). */
export type SessionStatusLike =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt?: number; message?: string; next?: number }

/** Un mensaje del server viene con sus partes pegadas. */
export type ServerMessage = {
  info: MessageLike
  parts: readonly PartLike[]
}

/** Lectura de partes: el server ya las trae pegadas; el store local por mensaje. */
export interface PartReader {
  /** `client.session.messages({ sessionID, limit })`: devuelve los más nuevos primero. */
  fetchServerMessages(sessionID: string, limit: number): Promise<readonly ServerMessage[]>
  /** Partes sincronizadas del TUI (`api.state.part`). */
  readParts(messageID: string): readonly PartLike[]
}

/** Origen de mensajes: store local del TUI + fallback al server (ventana de sync, C6). */
export interface MessageSource extends PartReader {
  /** Store sincronizado del TUI (`api.state.session.messages`), ascendente. */
  listStateMessages(sessionID: string): readonly MessageLike[]
}

/** Origen del estado de la sesión: store local + fallback al server (bootstrap, C5). */
export interface StatusSource {
  /** Store sincronizado (`api.state.session.status`); `undefined` en bootstrap. */
  readStateStatus(sessionID: string): SessionStatusLike | undefined
  /** `client.session.status({ directory })`: mapa sessionID → status (puede faltar la clave). */
  fetchServerStatus(): Promise<Readonly<Record<string, SessionStatusLike | undefined>>>
}

/** Resultado normalizado del write (los dos carriles del SDK colapsados). */
export type PartWriteOutcome = { ok: true } | { ok: false; error: unknown; status?: number }

/** Args del upsert (`client.session.part.update`, W0: es un UPSERT). */
export type UpdatePartArgs = {
  sessionID: string
  messageID: string
  partID: string
  directory: string
  part: PartLike
}

/** Args del borrado (`client.session.part.delete`, W0: idempotente). */
export type DeletePartArgs = {
  sessionID: string
  messageID: string
  partID: string
  directory: string
}

/** Escritura quirúrgica de partes con `directory` explícito. */
export interface PartWriter {
  updatePart(args: UpdatePartArgs): Promise<PartWriteOutcome>
  deletePart(args: DeletePartArgs): Promise<PartWriteOutcome>
}

/** Sesión scratch para el destilador (diseño §5, D6). */
export interface ScratchSession {
  /** Crea la sesión scratch; devuelve el sessionID. */
  createScratch(directory: string, title: string): Promise<string>
  /** Promptea la scratch y devuelve texto + modelo del assistant (con timeout). */
  promptScratch(
    sessionID: string,
    directory: string,
    text: string,
  ): Promise<{ text: string; model: { providerID: string; modelID: string } }>
  /** Borra la sesión scratch (siempre en finally). */
  deleteScratch(sessionID: string, directory: string): Promise<void>
}

/** Journal bindeado a un `directory` (firma espejo de `journal.ts`). */
export interface JournalPort {
  appendPlanned(entry: TraceEntry, ts: number): AppendPlannedResult
  appendStatus(sessionID: string, ts: number, status: string, at: number): AppendStatusResult
  readTraces(sessionID: string): ReadTracesResult
  latestTrace(sessionID: string): LatestTraceResult
}

/** Diálogo de confirmación (llamada directa al componente, sin JSX). */
export interface Confirmer {
  confirmDialog(title: string, message: string, onConfirm: () => void, onCancel: () => void): void
}

/** Diálogo de prompt de texto (solo para el "Custom…" de tipos, DEC-5). */
export interface Prompter {
  promptDialog(
    title: string,
    placeholder: string,
    onValue: (value: string) => void,
    onCancel: () => void,
  ): void
}

/** Opción del selector, genérica sobre el valor. */
export type SelectOption<T> = {
  title: string
  value: T
  description?: string
}

/** Diálogo de selección (timeline de tramos, tipos, trazas). */
export interface Selector {
  selectDialog<T>(
    title: string,
    options: readonly SelectOption<T>[],
    current: T | undefined,
    onSelect: (value: T) => void,
    onCancel: () => void,
  ): void
}

/** Toasts del host. */
export type ToastVariant = "info" | "success" | "warning" | "error"

export interface Toaster {
  toast(variant: ToastVariant, message: string): void
}

/** Ruta actual del TUI (para el gate de sesión). */
export interface RouteReader {
  currentRouteName(): string
  currentSessionID(): string | undefined
}

/** Directorio del proyecto activo (`api.state.path.directory`). */
export interface DirectoryReader {
  readDirectory(): string
}

/** Reloj inyectable (para previews deterministas). */
export interface Clock {
  now(): number
}

/** Todos los puertos que el flow necesita, juntos. */
export interface FlowPorts
  extends MessageSource,
    StatusSource,
    PartWriter,
    ScratchSession,
    JournalPort,
    Confirmer,
    Prompter,
    Selector,
    Toaster,
    RouteReader,
    DirectoryReader,
    Clock {}
