# Cadena completa de trazas (pristine reconstruction + restore por write-diff)

**Estado**: ✅ implementado (DEC-4, 2026-09-24).

## Contexto

El diseño original dejaba abierta la semántica de trazas solapadas: ante un tramo ya destilado, ¿se hace `refuse` o `re-distill`? (§10 fila "Doble-distill: `metadata.distilled` → refuse o re-distill desde el trace"). Metis F3 marcó el gap como blocker: trazas corruptas (¿full-parse o replay parcial?), fuera de orden (¿distillate huérfano?) y solapadas (¿qué `originals` gana?) dejaban a I8,reversibilidad, sin red de seguridad. Sin cerrar eso, I2/I3 y el restore quedaban colgando de una primitiva no definida.

## Decisión

**Cadena completa** (DEC-4 de Fede, 2026-09-24, ver `.omo/drafts/distill-implementacion-completa.md` DEC-4). Seis puntos cerrados:

1. `pristineReconstruct(sessionID, messageIDs)`, función pura: parte del estado actual e invierte en orden reverse-cronológico TODAS las trazas cuyo stretch intersecta esos mensajes (por traza: upsert mental de `originals` verbatim + remoción de `createdPartIDs`). Independiente del `status` e idempotente: invertir una traza ya restaurada es no-op.
2. **Input del destilador = `pristineReconstruct(stretch)`**, el destilador jamás ve stubs ni destilados previos. Re-distill sin drift universal, para cualquier patrón de solapamiento (§9).
3. **`restore(T)` = write-diff**: prístino del stretch de T (misma inversión, in-memory) vs estado actual → ops: UPDATEs (upserts de originales ausentes o cambiados, spread del original conservando `time`/`callID`/`state.input`) primero, DELETEs (partes sintéticas presentes en esos mensajes) después. Valen I1/I4/I5/I6 igual. Append de línea `restored` a la traza T.
4. **Trazas = JSONL append-only**: primera línea = `TraceEntry` completo con `status: "planned"` (write-ahead); cada transición (`executing`/`done`/`partial`/`restored`) se appendea como nueva línea del mismo entry; el lector toma la última línea como estado vigente. Nunca se reescribe historia.
5. **Traza corrupta o truncada**: full-parse antes de usar; cualquier operación que la necesite (re-distill o restore de un stretch que la intersecta) hace refuse con warn; un distill de stretch disjunto sigue (no depende de ella). DEC-4.5.
6. **Inversión con trazas corruptas**: `intersectingTraces` trata toda traza corrupta como intersectante (fail-closed), así que `pristineReconstruct` refusea si alguna toca el stretch.

## Por qué

Prístino universal: cualquier re-distill, por más solapamiento que haya, resume contenido original, no resúmenes de resúmenes. Restore seguro de trazas viejas: aunque haya destilaciones posteriores que solapan ese stretch, el write-diff deja el solape en prístino sin tocar las porciones disjuntas de las trazas posteriores. Sin ambigüedad de merge y sin depender del orden de escritura.

## Opciones consideradas

- **Exact-match + latest-only**, rechazada: solo permitía re-distill si el stretch coincidía exacto con una traza previa y solo restore de la última. Dejaba sin cubrir el caso dominante (solapamiento parcial) y obligaba al usuario a recordar IDs exactos.
- **Content-merge (mezclar destilados y originales según heurística)**, rechazada: ambiguo qué gana cuando dos trazas tocan el mismo mensaje con distinto `summary`; introduce drift acumulativo y rompe la propiedad "re-distill sin drift" de §9.
- **Replay parcial de traza corrupta**, rechazada (Metis F3): reinyectar solo las líneas parseables corrompe I8 de forma silenciosa; el diseño exige full-parse o refuse.

## Consecuencias

- Restaurar una traza vieja invalida la porción de destilaciones posteriores que solapaba ese stretch (sus porciones disjuntas siguen). El reporte no oculta esto: es coherente, no corrupto, y queda trazado en el journal (línea `restored`).
- Costo de inversión: `pristineReconstruct` recorre todas las trazas intersectantes en memoria; es O(trazas × partes) pero con trazas chicas (un stretch por traza) y ejecución solo en distill/restore, no en cada turno.
- Protocolo append-only: el reader siempre toma la última línea; `readTraces` ordena desc por nombre de archivo (timestamp) y `pristineReconstruct` invierte en ese orden. Nunca se reescribe una línea existente.
- Implementación: `src/journal.ts` (`pristineReconstruct`, `intersectingTraces`, `buildRestoreOps`), `src/flow.ts` (guards de corrupta en distill y restore), tests `test/journal.test.ts` + `test/chain.test.ts`, smoke `smoke-chain.ts` (`.omo/evidence/task-18-*.log`).
