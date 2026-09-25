# Hallazgos empíricos — primitivas de reescritura

> ✅ = verificado contra un server vivo. ⚠️ = supuesto o no verificado.
> Todo lo de este doc se probó con los scripts de [`scripts/`](../scripts/) contra
> OpenCode **1.18.32**, SDK v2 (`@opencode-ai/sdk@1.18.32`), modelo
> `litellm/deepseek-v4-flash`.

## Método (reproducible)

- **Server aislado**: `opencode serve --hostname 127.0.0.1 --port 4711 --pure`
  (sin plugins → sin auth). El server de uso diario en `:4096` tiene Basic auth;
  no se toca.
- **Sesión scratch**: cada smoke crea una sesión nueva en un directorio temporal
  (`/tmp/opencode/...`) y la borra al final. Nunca toca sesiones reales.
- **Harness**: [`scripts/run-smoke.sh`](../scripts/run-smoke.sh) levanta el server,
  corre un smoke y lo baja. Uso: `scripts/run-smoke.sh scripts/smoke-part-update.ts`.

## 1. Superficie de escritura ✅

| Primitiva | Resultado |
|---|---|
| `session.updateMessage` | **no existe** |
| `part.update({sessionID, messageID, partID, part})` | ✅ es **UPSERT**: reescribe la parte, o la **crea** si el `partID` no existe |
| `part.delete({sessionID, messageID, partID})` | ✅ idempotente (`200 true` aunque la parte no exista) |
| `session.deleteMessage` | ✅ existe (lo usa el plugin hermano); borra mensaje + todas sus partes |

## 2. Tabla de capacidades ✅

Corrida `smoke-part-update.ts`:

| Operación | Status |
|---|---|
| Reescribir `text.text` | `200` |
| Reescribir `reasoning.text` | `200` |
| Reescribir `tool.state.output` | `200` |
| Cambiar el `type` de una parte (`text`→`reasoning`) | `200` (sin validación) |
| Crear una parte nueva vía upsert (id arbitrario) | `200` |
| Tamper de `step-finish.tokens` (`input:1`) | `200` (sin validación) |
| `part.delete` de parte existente | `200 true` |
| `part.delete` de parte inexistente | `200 true` |
| `part.update` con `messageID` inexistente | `400 BadRequest` |

**Consecuencia de diseño**: se puede reescribir **y crear** partes. La reescritura
es a nivel de parte; el mensaje es un contenedor inmutable (id + orden). Para
inyectar una parte hay que apuntar a un `messageID` existente.

## 3. Taxonomía de partes (del SDK) ✅

`text` · `reasoning` · `tool` (estado pending/running/completed/error) · `file` ·
`step-start` · `step-finish` (cost/tokens/snapshot) · `snapshot` · `patch` ·
`agent` · `retry` · `compaction` · `subtask`.

## 4. ¿Lo mutado llega al modelo? ✅ (sí)

**Conductual** (`smoke-part-update.ts`): inyectar `"The launch code is BANANA-77"`
en una parte → el modelo respondió `BANANA-77` en el turno siguiente.

**Objetivo — delta de tokens de input** (`smoke-reasoning-tokens.ts`): tres
sesiones idénticas, cada una con una parte inyectada distinta; se mide
`step-finish.tokens.input` del turno siguiente:

| Sesión | input turno 2 |
|---|---|
| A (control) | 47077 |
| B (+`reasoning` de ~2000 tokens) | 49080 → **Δ 2003** |
| C (+`text` de ~2000 tokens) | 49078 → Δ 2001 |

El control positivo (C) valida el instrumento. **El `reasoning` también se
reenvía al contexto** (no es solo display).

⚠️ **Lección metodológica**: un test conductual aislado (`smoke-reasoning-only.ts`)
dio "dropped" — el modelo respondió *"There's no magic word"* cuando el secreto
estaba en el `reasoning`. Era un **refusal**, no ausencia de contexto: el
instrumento de tokens lo desmintió. **Para verificar contexto se mide tokens, no
se le pregunta al modelo.**

## 5. Coherencia (hallazgo cualitativo) ⚠️

Al reescribir `tool.state.output`, el `metadata.preview` de la tool **queda
desactualizado** (sigue mostrando el valor original). No rompe nada, pero genera
incoherencia visible: hay que reescribir también el preview o removerlo.

## 6. Caveats

- ⚠️ Todo se midió con `--pure` y modelo DeepSeek. El reenvío de `reasoning` puede
  variar por provider (ver [`03-investigacion-opencode.md`](03-investigacion-opencode.md)).
- ⚠️ No se midió prompt caching ni compactación.
- ⚠️ `part.update` sobre **mensajes de usuario** no se probó (el diseño no lo usa).
