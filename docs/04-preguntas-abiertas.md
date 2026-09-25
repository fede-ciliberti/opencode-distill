# Preguntas abiertas — backlog de verificación

> Cosas que el diseño asume o deja pendientes. Cada una con **cómo cerrarla**.
> Estado: todas 🔶 pendientes.

## Q1 — ¿Qué camino de contexto corre en 1.18.32 (v1 vs v2)?

- **Por qué importa**: define si `snapshot`/`patch`/`step-finish` se serializan al
  modelo. Si corriera v2 (mensajes tipados, sin partes internas), cambian las reglas
  de inclusión.
- **Cómo cerrar**: smoke que inyecte una parte `snapshot` con un texto marcador y
  mida el delta de tokens del turno siguiente. Δ≈0 → no se serializa; Δ>0 → sí.

## Q2 — ¿El `reasoning` reescrito conserva firma en providers estrictos?

- **Por qué importa**: Anthropic/Bedrock dropean reasoning sin firma. Si el provider
  dropea el reasoning reescrito, "plegar reasoning" no ahorra tokens ahí.
- **Cómo cerrar**: repetir `smoke-reasoning-tokens.ts` contra un provider
  Anthropic/Bedrock y comparar el delta.

## Q3 — ¿`prompt({noReply:true})` evita crear mensajes visibles?

- **Por qué importa**: solo si se descarta la *scratch session* como forma de
  destilar. Con scratch session, irrelevante.
- **Cómo cerrar**: `prompt` con `noReply:true` y luego `session.messages` — ¿aparece
  el mensaje del user?

## Q4 — ¿`part.update` con sesión busy devuelve 409?

- **Por qué importa**: define el guard. El diseño exige sesión idle igual, así que
  es *moot*, pero conviene saberlo para el mapeo de errores.
- **Cómo cerrar**: disparar un prompt async y, sin esperar, intentar `part.update`.

## Q5 — Serialización de `metadata` al modelo

- **Por qué importa**: si `metadata` viaja al modelo, no se puede usar como tombstone
  in-band (pagaría tokens). El diseño ya lo evita (trace en disco), pero confirmarlo
  cierra la puerta del todo.
- **Cómo cerrar**: inyectar una parte con `metadata` de tamaño marcado y medir tokens.

## Q6 — Orden de partes tras múltiples upserts

- **Por qué importa**: si el destilado depende del orden (texto antes que tool), hay
  que confirmar que el orden leído post-write es el esperado.
- **Cómo cerrar**: upsert de varias partes en un mensaje y leer el orden resultante.
