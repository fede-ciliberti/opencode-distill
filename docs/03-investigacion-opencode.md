# Investigación — cómo OpenCode arma el contexto

> 🔍 = hallazgo de investigación (source externo, vía subagentes librarian).
> ⚠️ = inferencia o punto no verificado localmente.
> Fuente: `anomalyco/opencode`, commit `0f54984`, branch `dev`. Los números de
> línea son de ese commit.

## 1. El hallazgo que reencuadra todo: `filterCompacted` 🔍

OpenCode **ya reescribe el pasado para el modelo sin tocar el storage**. En la
compactación, los mensajes viejos **no se borran**: el modelo deja de verlos
filtrando en lectura.

- `packages/opencode/src/session/message-v2.ts` → `filterCompacted` (L525-576).

**Implicancia de diseño**: el modelo "historial canónico + proyección mutable" que
planteamos **ya existe en el core**. Esa versión requeriría tocar el core; un
plugin no tiene una primitiva de *swap* de contexto. Por eso la decisión del ADR
0001 es reescritura in-place de partes (plugin-viable), no dos capas.

## 2. Dos caminos de ensamblado de contexto 🔍

| Camino | Conversor | Output |
|---|---|---|
| v1 / `MessageV2` | `toModelMessagesEffect` → `convertToModelMessages` (AI SDK) | `ModelMessage[]` |
| v2 / core runner | `toLLMMessages` | `Message[]` de `@opencode-ai/llm` |

Archivos: `packages/opencode/src/session/message-v2.ts` (L131-427),
`packages/opencode/src/provider/transform.ts` (`ProviderTransform.message`, L465-518),
`packages/core/src/session/runner/to-llm-message.ts` (L115-170).

⚠️ **No verificado** cuál de los dos corre en 1.18.32. Los deltas de tokens que
medimos son consistentes con v1.

## 3. Qué parte se incluye en el contexto (v1) 🔍

El conversor ramifica solo sobre un subconjunto; **el resto se dropea en silencio**:

| Parte | user | assistant |
|---|---|---|
| `text` | incluida si no vacía | incluida |
| `reasoning` | — | conservado **solo si es del mismo modelo**; si no, degradado a `text` |
| `tool` | — | `completed`→`output-available`, `error`→`output-error` |
| `file` | incluida (salvo text/plain) | dropeada |
| `step-start` | — | emitida; mensajes con solo `step-start` se filtran |
| `step-finish`, `snapshot`, `patch`, `agent`, `retry` | — | **dropeadas** |
| `compaction` | inyectada como texto `"What did we do so far?"` | — |
| `subtask` | inyectada como texto | — |

⚠️ Inferencia fuerte: los tipos internos (`step-*`, `snapshot`, `patch`) no se
serializan al proveedor. Irrelevante para la seguridad del diseño: el allowlist los
excluye igual.

## 4. Reasoning por provider 🔍

No hay un switch global "sacar reasoning". Son dos capas:

1. **Por identidad de modelo** (conversión): se conserva solo si el mensaje es del
   mismo `providerID/modelID`.
2. **Filtros por provider** (`transform.ts` → `normalizeMessages`): Anthropic dropea
   reasoning sin firma; Bedrock dropea sin `signature`; **DeepSeek inyecta**
   reasoning vacío; modelos con reasoning intercalado lo mueven a `providerOptions`.

**Implicancia**: reescribir `reasoning` puede no ahorrar tokens en providers
estrictos. Verificar por provider ([`04-preguntas-abiertas.md`](04-preguntas-abiertas.md), Q2).

## 5. Compact / revert / summarize / fork 🔍

- **Compactación**: `compaction.ts` escribe un mensaje user + parte `type:"compaction"`
  (`auto`, `overflow?`, `tail_start_id?`) y un assistant con `summary:true`. Los
  mensajes viejos no se borran (se filtran en lectura). `prune` marca
  `part.state.time.compacted` en outputs viejos de tools.
- **Revert V1** (`revert.ts`): no borra al revertir — **stagea** un registro y
  restaura snapshot. El borrado real (`cleanup`) corre antes del próximo prompt.
- **Revert V2**: `stage` / `clear` / `commit`; el projector borra filas con
  `seq > boundary`.
- **Fork** (`session.ts` L691-732, solo V1): copia `msgs.slice(0, target)`
  **exclusivo** del mensaje borde y remapea IDs.
- **Storage**: V1 = JSON por archivo; V2 = SQLite/drizzle con upsert por evento
  (reemplazo total del JSON, no update por campo).

## 6. No verificado / límites de esta investigación

- ⚠️ Qué camino (v1/v2) corre en 1.18.32.
- ⚠️ Serialización de `metadata` al modelo (desconocida).
- ⚠️ Orden de partes tras múltiples upserts (el projector ordena por `(message_id, id)`).
- 🔍 Referencias históricas (PRs) vinieron de web search sobre clone shallow; no
  afectan el diseño.
