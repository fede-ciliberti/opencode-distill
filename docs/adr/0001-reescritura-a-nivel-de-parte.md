# Reescritura del pasado a nivel de parte (no borrado de mensajes)

**Estado**: 🔶 firmado, pendiente de construir.

## Contexto

Queremos que una sesión de opencode pueda destilar tramos descarrilados *in-place*, para que los turnos futuros sean más cortos y baratos, sin la pérdida global de `/compact` ni el descarte de trabajo posterior del fork. Las primitivas disponibles son `part.update` (que es *upsert*) y `part.delete`; **no hay update de mensaje**.

## Decisión

Reescribir las **partes** mutables (`text`, `reasoning`, `tool.state.output`) dentro de los mensajes del tramo; **nunca borrar mensajes del medio**. El esqueleto de mensajes (ids, orden, `step-finish`, `snapshot`, `patch`) queda intacto. El tramo se colapsa a un destilado coherente en el primer mensaje + *stubs* de una línea en el resto.

## Por qué

`step-finish` guarda la contabilidad de costo y `snapshot`/`patch` anclan la reversibilidad de archivos. Borrar un mensaje del medio los arrastra en cascada → corrompe `/undo` y las métricas. La ganancia de tokens es idéntica reescribiendo partes, sin ese daño. Además, solo `text`/`reasoning`/`tool` se serializan al modelo, así que mutar esas partes es exactamente mutar el contexto efectivo del próximo turno.

## Opciones consideradas

- **Borrar mensajes del medio + inyectar el destilado** — rechazada: destruye contabilidad y reversibilidad; el delete de mensajes del medio no está verificado.
- **Dos capas (historial canónico + proyección mutable)** — rechazada para un plugin: requiere tocar el core (`filterCompacted`); no hay primitiva de *swap* de contexto accesible.
- **Tombstone in-band** (metadata o partes "ocultas") — rechazada: paga tokens en cada turno o depende de serialización de `metadata` no verificada.
- **`/compact` global y fork** — rechazadas por definición del problema.

## Consecuencias

- El registro de lo descartado va a un **trace sidecar en disco** (`<project>/.opencode/distill/`), no in-band; habilita *restore* por replay de upserts.
- El destilado se genera en una **scratch session** en `/tmp` con el modelo default del usuario.
- Reglas duras: allowlist de partes tocables, coherencia `tool`↔`texto`, frontera de compactación, orden UPDATE→DELETE (crash-safe).
- ⚠️ El `reasoning` reescrito puede degradarse según provider (Anthropic dropea reasoning sin firma); verificar por provider antes de confiar en el ahorro de tokens.
