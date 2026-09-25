# Ventana de selección: timeline por mensaje + tipos de contenido

**Estado**: ✅ implementado (DEC-5, 2026-09-24, post-firma pre-start).

## Contexto

El diseño §4 original definía la selección como slash args (`/distill`, `/distill <n>`, `/distill <first>..<last>`). Tras la firma, Fede pidió una ventana de confirmación con parámetros configurables: ver los tramos destilables con su uso en tokens y elegir qué tipos de contenido destilar. Esa brecha entre slash-args y una UX de selección real quedó registrada como DEC-5 y exigía cerrar el flujo, el scope del destilado y el umbral de masa.

## Decisión

**Cadena de diálogos sin slash args en el camino crítico** (DEC-5, D5 del draft). `/distill` abre, en orden:

1. **DialogSelect "Select stretch to distill"**, presets (`Current turn` / `Last 3` / `Last 5` / `All assistant messages`) + una fila por mensaje assistant elegible posterior a la frontera de compactación (`From <id>: "<preview>"` con `text N · reasoning N · tool N (≈M tok, estimate)`). Si se elige una fila `From`, se abre un segundo `DialogSelect` ("Select end of stretch") sobre la misma lista para cerrar el rango.
2. **DialogSelect "Select content types"**, presets (`Everything (text + reasoning + tool outputs)` / `Everything but tool outputs` / `Reasoning only` / `Tool outputs only` / `Custom…`). `Custom…` abre un `DialogPrompt` (`e.g. text reasoning tool`) cuyo input se valida con `parseTypeSpec` (tokens en `{text, reasoning, tool}`, case-insensitive, separados por espacios o comas).
3. **DialogConfirm "Confirm distillation"**, 5 líneas exactas (`buildConfirmMessage`): rango, breakdown por tipo con estimate, contexto `before → after`, cache one-time + break-even calificados como `estimate`, y nota del trace.

**Scope del destilado = tipos seleccionados.** El transcript que ve el destilador se arma ya filtrado (`buildTranscript` solo incluye partes de los tipos elegidos); el prompt lleva una línea de scope (`You are distilling only: …`). El `buildRewritePlan` respeta el scope: solo toca los buckets elegidos (stubs condicionales, tool-updates condicionales, deletes condicionales). La validación de masa mínima (500 chars, `MIN_STRETCH_CHARS`) se mide sobre la masa seleccionada, no sobre el total del stretch.

**Metadata de auditoría.** El `TraceEntry.distillate` guarda `metadata.types` (los tipos elegidos) y el plan guarda el breakdown; el reporte califica todo número de tokens como `estimate`.

**Fallback safe-mode.** Si `DialogSelect` no está disponible, el flow degrada a `DialogConfirm` con `current-turn + all types` en vez de abortar silenciosamente.

## Por qué

Timeline textual por mensaje + breakdown estimado responden al pedido de Fede ("ver los tramos con su uso en tokens y elegir qué tipos") sin introducir una superficie no verificada. Un timeline gráfico con JSX custom habría requerido render arbitrario dentro del TUI, fuera del allowlist de dialogs verificados (`DialogSelect`/`DialogConfirm`/`DialogPrompt`). El scope filtrado desde el transcript evita destilar contenido que el usuario pidió conservar y mantiene honesta la estimación (lo no seleccionado sigue pagando tokens y se declara).

## Opciones consideradas

- **Timeline visual con JSX custom**, rechazada: superficie no verificada, rompe la disciplina "sin JSX" del sibling y no hay evidencia de que el host renderice componentes arbitrarios dentro de los dialogs del plugin.
- **Global distill con filtered ops** (destilar todo el stretch y después filtrar ops por tipo), rechazada: el destilado resumiría contenido que el usuario excluyó, infla el prompt del destilador con contexto redundante y deja el ahorro estimado desalineado con el real.
- **Selección por parte individual**, rechazada: rompe el modelo de stretch de §4 (rango contiguo de mensajes assistant) y multiplica la complejidad de I1/I5 sin beneficio.
- **Tokens reales por mensaje**, descartada: no medibles por mensaje (los tokens que reporta el server son por step, no por mensaje); siempre `estimate = chars/4`.

## Consecuencias

- El transcript del destilador se construye ya filtrado; el modo condicional vive en `src/distill.ts` (`buildTranscript`) y en `src/pure.ts` (`buildRewritePlan`, `selectedChars`, `charsByType`, `buildTypeBreakdown`).
- Presets + custom cubren el 99% sin obligar a escribir; `parseTypeSpec` rechaza con `"Invalid content types, use: text, reasoning, tool"` y no hace writes.
- `metadata.types` en el trace permite auditar qué se destiló y re-distillar con el mismo scope.
- Fallback safe-mode si `DialogSelect` falla: el usuario sigue pudiendo destilar (current turn, all types) en vez de quedarse sin operación.
- Tokens siempre calificados como `estimate` (D11); el timeline es textual (`DialogSelect`), no gráfico.
- Implementación: `src/pure.ts` (timeline/types/breakdown/estimates/confirm), `src/distill.ts` (transcript filtrado + scope line), `src/flow.ts` (cadena select→select→confirm + fallback), `src/tui.ts` (probe de los 4 dialogs), tests `test/timeline.test.ts` + `test/select.test.ts` + `test/distill.test.ts` + `test/flow-distill.test.ts`.
