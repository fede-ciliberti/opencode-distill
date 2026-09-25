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

## Persistencia de metadata y synthetic ✅

Corrida `smoke-metadata.ts` (server aislado `--pure`, OpenCode 1.18.32, SDK v2).
Diseño sin-modelo: el mensaje contenedor se crea con `prompt(noReply:true)` y la
tool part de la sonda B se siembra por upsert — las 4 sondas preguntan por
**persistencia en el store** (read-back vía `session.messages`), no por
comportamiento del LLM.

| Sonda | Operación | Resultado |
|---|---|---|
| A | Upsert text nueva con `synthetic:true` + `metadata:{distilled,traceRef}` | ✅ `200`; read-back verbatim de ambos campos |
| B | Tool sembrada por upsert → reescribir `state.output` + `metadata.preview` | ✅ `200`; ambos persisten (el preview NO va stale si se reescribe junto al output) |
| C | Re-update de la misma parte tocando solo `text` | ✅ `200`; `metadata`/`synthetic` sobreviven (el update es merge del objeto, no reemplazo) |
| D | Upsert `prt_stub_*` con `metadata:{stub,traceRef}` | ✅ `200`; read-back verbatim |

**Consecuencia de diseño**: I2 (procedencia marcada) e I3 (coherencia
tool↔preview) son implementables con `part.update`: el marcado
`synthetic`+`metadata` persiste, sobrevive a re-toques de otros campos, y el
`metadata.preview` se puede reescribir en consonancia con `state.output`
(cierra el hallazgo §5: el preview solo va stale si NO se reescribe).

## Orden de partes ✅

Corrida `smoke-part-order.ts` (`PORT=4713 LOG=/tmp/opencode/distill-smoke-3.log scripts/run-smoke.sh scripts/smoke-part-order.ts`, exit 0):

- **Sonda 1**: 3 upserts nuevos en un mismo mensaje, en orden de inserción
  `prt_zeta_probe`, `prt_alfa_probe`, `prt_mm_probe` → el read-back vía
  `session.messages` devuelve `prt_alfa_probe`, `prt_mm_probe`,
  `prt_zeta_probe`. **El orden es por `id` ascendente, NO por inserción.**
  Confirma la inferencia de `03-investigacion-opencode.md:86` (el projector
  ordena por `(message_id, id)`).
- **Sonda 2**: re-upsert de `prt_alfa_probe` cambiando solo `text` → su
  posición no cambia (índice 1 antes y después). **Reescribir no reordena.**
- **Sonda 3**: la parte pre-existente del server (`prt_0d86…`) queda en índice
  0 y las nuevas después. Ojo: `prt_0d86… < prt_alfa…` lexicográficamente, así
  que esta corrida no distingue "append después" de "id-asc global" — en la
  práctica toda la lista observada es id-asc.

**Implicancia de diseño**: el destilado NO puede depender del orden de
inserción ni de la posición de las partes — el plan-builder de la task #7 ya
está diseñado order-independent. Si alguna vez hiciera falta un orden
narrativo (texto antes que tool), habría que lograrlo vía elección de los
`partID` (prefijos que ordenen), no vía secuencia de writes.

⚠️ Nota metodológica: medido sobre mensaje **user** vía `prompt({noReply:true})`
(sin invocar al modelo — litellm no responde bajo `--pure`, el prompt con
modelo colgó 240 s). El orden es nivel storage (projector), independiente del
rol; si hiciera falta, repetir sobre assistant cuando el provider responda.

## 7. Frontera de compactación ✅ (smoke-compaction-boundary.ts, 2026-09-25)

Corrida `PORT=4714 LOG=/tmp/opencode/distill-smoke-4.log scripts/run-smoke.sh scripts/smoke-compaction-boundary.ts`
(exit 0; modelo `litellm/gpt-oss-20b` — el default `deepseek-v4-flash` no responde en este entorno):

| Sonda | Resultado |
|---|---|
| `v2.session.compact` | `503 ServiceUnavailableError` "Session compact is not available yet" — **no operativo en 1.18.32** |
| `session.summarize` (vía operativa) | `200 true`; escribe user+`compaction` / assistant+`summary` |
| Parte `compaction` medida | `{"id","sessionID","messageID","type":"compaction","auto":false}` — **sin `tail_start_id`, sin `overflow`** |
| `tail_start_id` legible | **NO** → rige el FALLBACK |
| Mensajes previos en `session.messages` | 5/5 presentes → storage intacto ✅ |
| Assistant con `summary:true` | 1 mensaje, `mode/agent:"compaction"`, `parentID` = msg de compactación ✅ |
| `v2.session.context` | `{"data":[]}` antes y después — no usable como instrumento ⚠️ |

**Regla de frontera I7 (FALLBACK, fijo)**: como `tail_start_id` no es legible,
la frontera = **inicio de sesión** (todo stretch es válido). El stretch igual
debe excluir mensajes con `summary:true` o partes `type:"compaction"`.

## Escrituras con sesión busy ✅

Corrida `smoke-busy.ts` (server `--pure` 1.18.32, modelo `litellm/muse-spark-1.3-contributor`):
sesión scratch con turno setup en idle, luego `promptAsync` (ensayo de 500 palabras,
`204` inmediato) y probes mientras `session.status` = `{"type":"busy"}`.

| Operación | busy | idle |
|---|---|---|
| `part.update` de parte existente | `200` (aplica el write) | `200` |
| `part.delete` de parte existente | `200 true` | `200 true` |
| `session.messages` (lectura) | `200` (permitida) | `200` |
| `session.status` | `{"type":"busy"}` | `{}` (clave ausente = idle) |

**No hay 409.** El server **no** rechaza writes con sesión busy: `part.update` y
`part.delete` aplican igual que en idle, sin error ni shape distintivo. Tampoco hay
shape de error busy que mapear: la columna busy es idéntica a la idle.

**Consecuencia de diseño**: el guard 5 (`solo writes con sesión idle`, diseño §8)
tiene que ser **client-side** (`session.status` antes de EXECUTE + re-check
pre-EXECUTE, como ya prevé el flow del todo 14). El server no te protege de
pisar un turno en curso; un write en busy puede corromper el tramo que el modelo
está generando. Para `mapUpdateError` (todo 14): no existe rama busy por
status/error-body — busy se detecta por `session.status`, no por el error del write.

Notas de método: `prompt` bloquea hasta el fin del turno (no sirve para busy);
hay que usar `promptAsync` (`204` inmediato). `session.status` devuelve un mapa
`sessionID → {type:"busy"}`; en idle la clave de la sesión está ausente (`{}`).
Timeouts usados: setup-turn 240 s, waitForIdle 240 s, cleanup-idle 30 s.

## Distill end-to-end ✅ (smoke-distill-e2e.ts, 2026-09-25)

Corrida `SMOKE_MODEL=gpt-oss-20b SMOKE_DISTILL_MODEL=muse-spark-1.3-contributor PORT=4716 LOG=/tmp/opencode/distill-smoke-17c.log scripts/run-smoke.sh scripts/smoke-distill-e2e.ts`
(exit 0; el default `deepseek-v4-flash` no responde en este entorno; `gpt-oss-20b`
no parsea el formato del destilador —ver nota—, así que destila `muse-spark`).
El modelo es configurable: `SMOKE_MODEL` (turnos + comparación) y
`SMOKE_DISTILL_MODEL` (scratch del destilador), ambos default `muse-spark-1.3-contributor`.
Evidencia cruda: `.omo/evidence/task-17-distill-implementacion-completa.log`.
One-time (Metis F10), no gate de regresión. Importa código real de `src/`
(`selectStretch`/`snapshotForTrace`/`buildRewritePlan`/`simulatePlan`/`partHash`/`selectedChars`,
`buildBudget`/`buildTranscript`/`buildDistillPrompt`/`parseDistillOutput`/`userRequestFor`/`estTokens`,
`appendPlanned`/`pristineReconstruct`/`buildRestoreOps`) — jamás replica.

Diseño: dos twins en scratch dirs separados con 3 turnos idénticos (cada uno con
tool call real `read` sobre un case-file distinto: FLAMMABLE/MAGNETIC/VOLCANIC).
Twin A = control (sin destilar) + turno de comparación (`tokens.input` = 35686).
Twin B = `selectStretch(current-turn)` → 2 mensajes del último turno →
snapshot (3 originales + `partHash` por parte) → scratch prompt real
(parse ok al intento 1) → plan (5 ops: distillate + stub + tool-update, 2 deletes;
`before=3429` chars → `after=406`, break-even 1) → `simulatePlan` ok (I1–I8) →
EXECUTE manual (`part.update` → `part.delete`) → VERIFY por read-back →
intento de turno de comparación → RESTORE por cadena real del journal.

| Check | Resultado |
|---|---|
| I1 (cada mensaje retiene ≥1 text no vacío) | OK × 2 mensajes |
| I2 (destilado `prt_distill_*` con `synthetic`+`metadata.distilled/traceRef`) | OK |
| I3 (tool stubeada `[distilled] …`, `metadata.preview` == `state.output`) | OK |
| RESTORE (`buildRestoreOps` → execute → read-back == snapshot por `partHash`, creadas eliminadas) | OK 3/3 + 2/2 gone |

⚠️ **Medición NO-COMPARABLE (finding, no aborta)**: el turno de comparación
post-distill falla con `UnknownError` "Invalid prompt: The messages do not match
the ModelMessage[] schema" (assistant vacío, 12 reintentos × 5 s) — con
`muse-spark-1.3-contributor` Y con `gpt-oss-20b` (el rechazo es independiente del
modelo; ver causa abajo). El Δ A−B no es medible en este entorno
(`tokensA=35686`, `tokensBpre=35179`, ahorro `2992` chars ≈ `748` tokens
estimados). CAVEAT registrado en el output: el Δ incluiría el mensaje de
comparación + ruido del provider; es evidencia, no gate.

**Causa precisa** (sonda acotada `scripts/smoke-distill-cause.ts`, 7 brazos,
`gpt-oss-20b`, evidencia `.omo/evidence/task-17-cause-probe.log`): el que rompe
el schema es el campo **`metadata` no-vacío en una text part**, no el
`synthetic`, ni el id, ni el orden, ni el borrado:

| Brazo | Inyección | Turno siguiente |
|---|---|---|
| a texto plano (`prt_cause_plain`) | 200 | OK |
| e solo `synthetic:true` | 200 | OK |
| g id `prt_distill_*` plano | 200 | OK |
| d delete del text original | 200 | OK |
| b `synthetic`+`metadata{distilled,traceRef}` | 200 | **REJECTED** |
| f solo `metadata{distilled,traceRef}` | 200 | **REJECTED** |
| c tool stubeada (`output`+`metadata.preview`) | 200 | **REJECTED** |

El store acepta todo (`200` en los 7 writes); el rechazo ocurre al construir el
prompt del turno siguiente. Hipótesis del mecanismo: el projector serializa
`metadata` dentro del mensaje del provider y el schema `ModelMessage[]` lo
rechaza (o la tool stubeada pierde `title`/`time` requeridos al reescribirse).
NO es el orden `text-after-step-finish` (el brazo a también deja texto al final
y pasa) ni el flag `synthetic` solo (brazo e pasa).

**Consecuencias de diseño**:

1. El restore por cadena real del journal funciona end-to-end (pristine →
   write-diff → execute → read-back idéntico por hash). La cadena DEC-4 está
   validada contra un server vivo, no solo en unit tests.
2. ⚠️ **Finding para el plan owner (defecto real, `src/` intacto)**: I2
   (procedencia marcada vía `metadata`) e I3 (coherencia vía
   `metadata.preview`) son persistibles (verificados en task #2) pero el tramo
   marcado **rompe el turno siguiente** en este entorno: cualquier text part con
   `metadata` no-vacío hace que el provider rechace el prompt. Opciones: (a)
   marcar procedencia sin `metadata` (p. ej. prefijo textual `[distilled …]` en
   el `text`, ya presente en el tool-stub), (b) verificar si el rechazo es
   específico de LiteLLM/proxy vs OpenCode projector, (c) medir con un provider
   que tolere metadata. Decisión pendiente — tasks #18-20 no deberían asumir que
   el tramo destilado es conversable.
3. `buildRestoreOps` opera sobre partes mutables (`text`/`reasoning`/`tool`):
   pasarle el mapa completo (con `step-start`/`step-finish`) refusea con
   `disallowed-part-type`. El flow filtra antes de llamar (el smoke lo hace
   explícito en `mutableOnly`).
4. Nota de modelo: `gpt-oss-20b` como destilador NO sirve — devuelve los stubs
   como `[1]: read el archivo…` (con corchetes) y `parseDistillOutput` lo
   rechaza (`Unparseable stub line`, 3/3 intentos idénticos). El destilador queda
   en `muse-spark-1.3-contributor`.
