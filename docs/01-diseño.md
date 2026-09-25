# Diseño — `distill`: reescritura selectiva del pasado

> Fuente de verdad del diseño. Flujo visual en
> [`diagrams/flujo-distill.mmd`](diagrams/flujo-distill.mmd).
> Primitivas verificadas: [`02-hallazgos-empiricos.md`](02-hallazgos-empiricos.md).
> Decisión central: [`adr/0001-reescritura-a-nivel-de-parte.md`](adr/0001-reescritura-a-nivel-de-parte.md).

## 0. Resumen ejecutivo

Un comando que **reescribe el pasado de una sesión in-place**: agarra un tramo de
trabajo descarrilado, lo reemplaza por una versión destilada y coherente, y deja el
resto intacto. No es compactar (global, pierde todo) ni forkear (descarta lo
posterior). La mutación es a nivel de **parte** (`text`, `reasoning`,
`tool.state.output`); el esqueleto de mensajes (`ids`, orden, `step-finish`,
`snapshot`, `patch`) queda intacto. El registro de lo descartado va a un **trace
sidecar en disco**.

## 1. Primitivas → implicaciones

| Primitiva (verificada) | Implicación |
|---|---|
| No hay `session.updateMessage` | La única vía de mutación es a nivel part |
| `part.update` = upsert (crea si el id no existe) | IDs deterministas; **restore = replay de upserts** |
| `part.delete` idempotente | El plan es re-ejecutable ante crash |
| `text`/`reasoning`/`tool` llegan al modelo | Reescribir esas partes = reescribir el contexto efectivo |
| No se crean mensajes assistant | El destilado vive **dentro de mensajes existentes** |
| `snapshot`/`patch`/`step-finish` anclan reversibilidad y contabilidad | Tocarlos o borrar sus mensajes = corrupción → **prohibidos** |

## 2. Decisión central y alternativas

**"Part-level surgical rewrite, skeleton intact"**: el tramo (rango contiguo de
mensajes assistant) se colapsa reescribiendo sus partes mutables; el primer mensaje
porta el destilado coherente, el resto queda con *stubs* de una línea. Alternativas
rechazadas y su porqué: ver el ADR 0001.

## 3. Modelo de datos

```ts
type Stretch = {
  sessionID: string
  directory: string
  messageIDs: readonly string[]   // assistants CONTIGUOS, orden ascendente
}

type Distillate = {
  summary: string                 // bloque coherente, va en el primer mensaje
  stubs: Record<string, string>   // messageID -> stub de una línea
  model: { providerID: string; modelID: string }
}

type PartOp =
  | { kind: "update"; messageID: string; part: Part }   // spread del original + campos cambiados
  | { kind: "delete"; messageID: string; partID: string }

type RewritePlan = {
  stretch: Stretch
  ops: readonly PartOp[]
  mass: { beforeChars: number; afterChars: number; cacheInvalidationFrom: string; estBreakEvenTurns: number }
}

type TraceEntry = {   // JSONL, write-ahead
  version: 1
  sessionID: string
  createdAt: number
  stretch: readonly string[]
  originals: Array<{ messageID: string; part: Part }>   // verbatim pre-op
  createdPartIDs: readonly string[]                     // restore las borra
  plan: readonly PartOp[]
  distillate: Distillate
  status: "planned" | "executing" | "done" | "partial" | "restored"
}
```

IDs deterministas (idempotencia): destilado `prt_distill_<hash8(stretch)>`, cada
stub `prt_stub_<messageID>`. Re-ejecutar sobrescribe en vez de apilar.

Marcado: el `text` del destilado lleva `synthetic: true` (campo del SDK;
comportamiento server-side no verificado) + `metadata: { distilled: true, traceRef }`.

## 4. Unidad de reescritura y selección

- **Unidad de mutación**: la parte (allowlist `text`/`reasoning`/`tool`).
- **Unidad de selección**: el *stretch* = rango contiguo de mensajes assistant,
  estrictamente posterior al último `tail_start_id` de compactación (lo anterior ya
  está fuera del contexto: reescribirlo ahorra 0 tokens).
- **UX de selección**:
  - MVP default: `/distill` = el turno actual (todo lo posterior al último user).
  - MVP explícito: `/distill <n>` = últimos n assistants.
  - v2: rango arbitrario `[firstMessageID, lastMessageID]` (el modelo ya lo soporta).
- **Preview obligatorio** antes de escribir: rango, masa antes/después, punto de
  invalidación de cache, break-even.

## 5. Algoritmo de destilación

### 5.1 Qué preservar vs. tirar

| PRESERVAR (lo caro de re-descubrir) | TIRAR (el derrotero) |
|---|---|
| Root cause / conclusión final | Llamadas repetidas sin valor |
| Cada decisión + su rationale | Outputs crudos ya capturados |
| **Resultados negativos**: hipótesis descartadas + la evidencia que las mató | Restatement de razonamiento |
| Artefactos: `file:line`, errores, comandos, IDs/valores | Dead ends sin lección |
| Threads abiertos | |

### 5.2 Ejecución del destilador

**Scratch session** en `/tmp/opencode/distill-<ts>` (nunca el dir del proyecto):
`session.create` → `prompt` → leer text parts → `session.delete`. Usa el modelo
default del usuario; cero credenciales nuevas.

**Prompt** (instrucción al destilador):

```
You are distilling a debugging transcript. You receive: (1) the user request
that started this stretch, (2) a numbered verbatim transcript of the assistant's
work (reasoning, tool calls with inputs/outputs, replies), in order.

Produce a distilled REPLACEMENT that a future assistant turn will read as if it
were the original work.

MUST keep:
- The root cause / final conclusion, if reached.
- Every decision and its rationale.
- Negative results: each hypothesis tested and RULED OUT, with the one-line
  evidence that killed it. Highest-value content.
- Key artifacts: file paths, line numbers, exact error strings, commands that
  worked, discovered values/IDs.
- Open threads (or "none").

MUST drop:
- Exploration with no information value; redundant restatements; raw output
  already captured in a kept item.

Format (strict, no preamble):
<distillate>
## Outcome
<1-3 sentences>
## Ruled out
- <hypothesis> — <evidence>
## Key facts
- <artifact> — <why it matters>
## Open
- <... | none>
</distillate>
<stubs>
<n>: <≤15 words, past tense, what message n did>
</stubs>

Constraints: distillate ≤ <budget> tokens. Do not invent facts. If evidence for a
kept claim is missing, keep the claim and mark it (unverified).
```

**Validación de salida** (antes de cualquier write): destilado no vacío y ≤ budget;
`stubs` cubre exactamente los mensajes del stretch. Falla de parse → abort limpio.

**Budget**: `min(1024 tokens, 25% de la masa original)`.

## 6. Invariantes de coherencia

| # | Invariante | Enforcement |
|---|---|---|
| I1 | Ningún mensaje del stretch queda con 0 partes visibles (ensamblado de mensaje vacío: no verificado) | Cada mensaje retiene ≥1 `text` no vacío en todo estado intermedio y final |
| I2 | Procedencia marcada | `synthetic:true` + `metadata.distilled`/`stub` con `traceRef` |
| I3 | Coherencia tool ↔ texto ↔ preview | Tool conservado → `state.output` stub + `metadata.preview` en consonancia; tool borrado → ningún `callID` huérfano en texto |
| I4 | Contabilidad/reversibilidad intocadas | **Allowlist duro**: solo ops sobre `text`/`reasoning`/`tool`; una op fuera → plan inválido |
| I5 | Localidad | Ops solo dentro del stretch; partes nuevas solo por upsert dentro del stretch |
| I6 | User messages inmutables | Guard explícito |
| I7 | Frontera de compactación | Stretch posterior al último `tail_start_id`; sin `summary`/`compaction` dentro |
| I8 | Reversibilidad del mecanismo | Trace write-ahead; restore = replay de upserts + deletes idempotentes |

**Regla de construcción**: nunca construir una parte desde cero al reescribir —
siempre `spread` del original, cambiando solo los campos objetivo (preserva `time`,
`callID`, `state.input`).

## 7. Algoritmo paso a paso

```
distill(sessionID, stretchSpec):
 1. GATE      ruta=session; sesión idle (busy/retry → refuse)
 2. LOAD      mensajes+partes (store local, fallback server)
 3. VALIDATE  stretch: contiguo, solo assistants, I7, masa mínima
 4. SNAPSHOT  originales de todas las partes mutables del stretch
 5. DISTILL   scratch session → distillate + stubs → validar (abort sin writes si falla)
 6. PLAN      UPDATEs primero (destilado + stubs + tool outputs), DELETEs después;
              correr I1–I8 en simulación → violación aborta
 7. CONFIRM   diálogo: rango, masa, cache, break-even
 8. RE-VALID  hash de contenido por parte == snapshot (drift → abort)
 9. TRACE     escribir sidecar status="planned" (write-ahead)
10. EXECUTE   UPDATEs → DELETEs; fallo mid-batch → STOP, status="partial", ofrecer restore
11. REPORT    toast con ahorro; status="done"

restore(sessionID, traceRef):
  guards idle → part.update(original) por cada original  // recrea los borrados
              → part.delete por cada createdPartID         // idempotente
```

**Orden UPDATE→DELETE = crash-safety**: un crash deja el estado "sobre-lleno",
nunca vacío (I1 vale en todo intermedio).

## 8. Guards de seguridad

1. **Allowlist (I4)**: `step-start`, `step-finish`, `snapshot`, `patch`, `file`,
   `agent`, `retry`, `compaction`, `subtask` — ni update ni delete. Se valida contra
   el tipo **fetch-eado**, no el esperado.
2. **Cache de prompt**: invalidación por posición. El diálogo declara costo one-time
   y break-even. Regla: destilar en el tail rinde; destilar temprano se amortiza.
3. **Idempotencia**: upserts con IDs deterministas + deletes idempotentes.
4. **Re-validación**: hash por parte; drift dentro del stretch → abort; appends fuera → proceed.
5. **Busy**: solo writes con sesión idle.
6. **`/undo`**: revert usa snapshots — intactos. El contenido destilado no se
   restaura con revert (para eso está `restore`).

## 9. Trace: sidecar en disco + destructivo en sesión

Reescritura **destructiva** dentro de la sesión + **trace sidecar** en
`<project>/.opencode/distill/<sessionID>/<ts>.jsonl` con los originales verbatim.

- El objetivo es contexto más barato: un tombstone in-band paga tokens en cada
  turno (o depende de serialización de `metadata` no verificada). Descartado.
- El trace da: registro auditable, re-distill sin drift, y **undo exacto gratis**
  (gracias a la semántica upsert: restore = replay).
- Costo: un archivo local por operación (gitigneable). Trace faltante/corrupto →
  distill sigue, restore no disponible (warn).

## 10. Failure modes

| Falla | Comportamiento |
|---|---|
| Destilador devuelve basura | Abort en validación, **cero writes** |
| Sesión cambió durante el destilado | Hash-check: drift dentro → abort; appends fuera → proceed |
| Crash mid-ejecución | Trace write-ahead + UPDATE→DELETE: estado "sobre-lleno"; re-ejecutar o restore |
| `part.update` → 400/409/404 | Abort + oferta de restore; mapeo de errores reusando `mapDeleteError` |
| Turno assistant vacío rechazado | Prevenido por I1 |
| Doble-distill | `metadata.distilled` → refuse o re-distill desde el trace |
| Compactación posterior | Compacta el destilado (resumen de resumen): correcto |

## 11. MVP scope

**In**:
- `/distill` (turno actual) y `/distill <n>`; paleta + slash.
- Destilador vía scratch session en dir temporal.
- Plan con allowlist, fases UPDATE→DELETE, validación I1–I8.
- Diálogo de confirmación con estimaciones + re-validación stale.
- Trace sidecar write-ahead + `/distill-restore`.
- Arquitectura `pure.ts` / `ports.ts` / `flow.ts` / `tui.ts` (+ `distill.ts`,
  `journal.ts` puros), misma disciplina que el plugin hermano.

**Out (v1)**: rangos arbitrarios por IDs, selección semántica, modelo destilador
configurable, auto-distill por umbral de tokens, destilado multi-sesión.
