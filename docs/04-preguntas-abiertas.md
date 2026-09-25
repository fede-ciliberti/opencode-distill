# Preguntas abiertas — backlog de verificación

> Cosas que el diseño asume o deja pendientes. Cada una con **cómo cerrarla**.
> Estado: todas 🔶 pendientes.

## Q1 — ¿Qué camino de contexto corre en 1.18.32 (v1 vs v2)? ✅ CERRADA (informativa, D15)

- **Hallazgo** (`scripts/smoke-context-markers.ts`, `PORT=4718`, modelo
  `litellm/muse-spark-1.3-contributor`, evidencia
  `.omo/evidence/task-19-distill-implementacion-completa.log`): tres sesiones
  idénticas con tool call real; inyección en el último assistant del turno 1;
  `step-finish.tokens.input` del turno 2:
  A(control)=135, B(+`snapshot` ~12.6k chars con marker `SNAPSHOT-MARK-42`)=107,
  C(+`text` ~14k chars)=2068 → **Δ B−A = −28 (≈0), Δ C−A = 1933**.
  El control positivo (C) valida el instrumento; el `snapshot` inyectado por
  upsert (`200`) **no mueve los tokens del turno siguiente**.
- **Implicancia**: sugiere que las partes `snapshot` no se serializan al modelo
  (consistente con docs/03 §3, camino v1). Informativo (D15): no bloquea el
  build ni se presenta como certeza — el allowlist ya las excluía igual.

## Q2 — ¿El `reasoning` reescrito conserva firma en providers estrictos? 🔶 ABIERTA (SKIP con evidencia)

- **Por qué importa**: Anthropic/Bedrock dropean reasoning sin firma. Si el provider
  dropea el reasoning reescrito, "plegar reasoning" no ahorra tokens ahí.
- **Intento** (misma corrida task #19): el server aislado lista `anthropic`
  configurado (modelos `claude-haiku-4-5`, etc.), pero los 3 brazos
  (control/reasoning/text) contra `anthropic/claude-haiku-4-5` devuelven
  assistant vacío con error `"Your credit balance is too low to access the
  Anthropic API"` — sin credencial viva en este entorno, el Δ no es medible.
- **Cómo cerrar (pendiente)**: repetir `smoke-reasoning-tokens.ts` contra un
  provider Anthropic/Bedrock con crédito cuando haya uno disponible. La
  limitación va al README (task #22).

## Q3 — ¿`prompt({noReply:true})` evita crear mensajes visibles?

- **Por qué importa**: solo si se descarta la *scratch session* como forma de
  destilar. Con scratch session, irrelevante.
- **Cómo cerrar**: `prompt` con `noReply:true` y luego `session.messages` — ¿aparece
  el mensaje del user?

## Q4 — ¿`part.update` con sesión busy devuelve 409? ✅ (no)

- **Hallazgo**: no. `smoke-busy.ts` confirma que con `session.status = {"type":"busy"}`
  tanto `part.update` como `part.delete` devuelven `200` y aplican el write igual que
  en idle; `session.messages` también devuelve `200`. No existe shape de error busy.
- **Implicancia**: el guard de sesión idle tiene que ser client-side (`session.status`
  pre-EXECUTE + re-check); el server no protege contra writes concurrentes al turno.
  `mapUpdateError` (todo 14) no lleva rama busy por status/error — busy se detecta
  por `session.status`.

## Q5 — Serialización de `metadata` al modelo ✅ CERRADA POR RECHAZO (informativa, D15)

- **Hallazgo** (misma corrida task #19): text part corta (`"SHORT VISIBLE TEXT"`)
  con `metadata.blob` de ~7.8 KB (marker `META-MARK-77` repetido); upsert `200`;
  el turno siguiente es **RECHAZADO** — assistant vacío, error `"Invalid prompt:
  The messages do not match the ModelMessage[] schema."` (control D sin
  metadata: `tokens.input=66`, responde normal). No hay Δ que medir y no se
  inventa ninguno.
- **Implicancia**: esto **supersede/refina el framing original de Q5** ("medir
  tokens"): la `metadata` no-vacía no solo no-viaja-silenciosa — **rompe el
  prompt siguiente** en este entorno (confirma y generaliza el finding de task
  #17 con metadata chica a ~8 KB). La puerta del tombstone in-band queda
  cerrada por partida doble: pagaría tokens (si viajara) y de hecho rechaza.
  Informativo (D15): medido con `muse-spark-1.3-contributor` vía LiteLLM/proxy;
  en otro provider podría diferir — el diseño ya evita metadata (trace en disco).

## Q6 — Orden de partes tras múltiples upserts ✅ CERRADA

- **Hallazgo**: el read-back ordena por `id` ascendente, no por inserción
  (`smoke-part-order.ts`: inserción zeta,alfa,mm → lectura alfa,mm,zeta).
  Reescribir una parte no mueve su posición. Ver `02-hallazgos-empiricos.md`
  "Orden de partes".
- **Implicancia**: el destilado no puede depender del orden de inserción; el
  plan-builder (task #7) es order-independent por diseño.
