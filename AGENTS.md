# AGENTS.md, opencode-distill

> Índice de propagación del proyecto. Declara **dónde vive cada cosa** para que
> una sesión nueva pueda retomar sin leer el historial de chat.

## Qué es

Plugin TUI de [opencode](https://github.com/anomalyco/opencode) para **destilar
tramos descarrilados de una sesión in-place**: reescribe partes de mensajes
(`text`, `reasoning`, `tool.output`) para acortar y abaratar los turnos futuros,
sin compactar todo ni forkear.

## Estado

✅ **Construido.** Plugin TUI funcional con 223 tests en verde (`bun test`), smokes de evidencia contra server `--pure`, y QA manual en TUI real. La cadena completa de trazas (DEC-4) y la ventana de selección timeline+tipos (DEC-5) están implementadas. Ver limitaciones conocidas en `README.md` (metadata rompe el turno siguiente, decisión del owner pendiente, Q2 inconclusa) y en `docs/02`/`docs/04`.

## Stack

- OpenCode **1.18.32** (binario en `~/.opencode/bin/opencode`), SDK v2
  (`@opencode-ai/sdk@1.18.32`), plugin TUI.
- **Runtime = Bun 1.3.2** (no Node). Los scripts son `.ts` ejecutados directo por
  `bun run`; `@types/bun` es la única fuente de tipos. Usar `bun install`, no
  `npm install`.
- **Build**: `tsc -p tsconfig.json` compila `src/` → `dist/` (`exports: "./tui"`). Hay que correr `bun run build` antes de `bun test` porque `test/entry.test.ts` importa `dist/tui.js`.

## Índice de propagación (fuente de verdad)

| Concepto | Fuente de verdad |
|---|---|
| Diseño del mecanismo (modelo de datos, invariantes, algoritmo, MVP) | [`docs/01-diseño.md`](docs/01-diseño.md) |
| Primitivas verificadas (qué acepta el server) | [`docs/02-hallazgos-empiricos.md`](docs/02-hallazgos-empiricos.md) |
| Cómo OpenCode arma el contexto (internals) | [`docs/03-investigacion-opencode.md`](docs/03-investigacion-opencode.md) |
| Backlog de verificación | [`docs/04-preguntas-abiertas.md`](docs/04-preguntas-abiertas.md) |
| Decisiones de arquitectura | [`docs/adr/`](docs/adr/), `0001-reescritura-a-nivel-de-parte`, `0002-cadena-de-trazas` (DEC-4), `0003-seleccion-timeline-tipos` (DEC-5) |
| Diagramas (Mermaid puro, `.mmd`) | [`docs/diagrams/`](docs/diagrams/), `flujo-distill.mmd` (distill + restore + cadena) |
| Código fuente | [`src/`](src/), `pure.ts` (selección/plan/I1,I8/hashes/estimates), `distill.ts` (prompt/transcript filtrado/parser), `journal.ts` (trace JSONL + `pristineReconstruct`/`buildRestoreOps`), `ports.ts` (FlowPorts), `flow.ts` (orquestación distill + restore), `tui.ts` (registro y adaptadores) |
| Tests | [`test/`](test/), 15 archivos, 223 tests (pure/plan/invariantes/journal/distill/flow/chain/timeline/estimates/entry/contract/tui-part) |
| QA manual | [`QA.md`](QA.md), 22 casos con strings exactos de `src/flow.ts` |
| Evidencia reproducible (smokes) | [`scripts/`](scripts/), harness `run-smoke.sh` + smokes (`smoke-part-update`, `smoke-metadata`, `smoke-part-order`, `smoke-compaction-boundary`, `smoke-busy`, `smoke-distill-e2e`, `smoke-chain`, `smoke-context-markers`) |

## Cómo reproducir la evidencia

```bash
bun install                                              # baja el SDK (devDependency)
bun run build                                            # compila src -> dist (requerido antes de bun test)
bun test                                                 # 223 tests en verde
bun run typecheck                                        # tsc --noEmit + tsc -p tsconfig.test.json
scripts/run-smoke.sh scripts/smoke-part-update.ts        # harness: levanta server y corre el smoke
```

**`run-smoke.sh` es el harness, no los `smoke:*` de `package.json`.** Los scripts
npm corren el smoke contra el default `http://127.0.0.1:4096`, que es el server de
uso diario con Basic auth, **el target equivocado**. El harness usa
`opencode serve --pure` en `127.0.0.1:4711` (sin plugins → sin auth).

Contrato de entorno del harness:

| Var | Default | Rol |
|---|---|---|
| `PORT` | `4711` | puerto del server aislado (falla si está ocupado) |
| `LOG` | `/tmp/opencode/distill-smoke-server.log` | log del server |
| `OPENCODE_URL` | `http://127.0.0.1:4096` en los smokes | lo inyecta el harness; los smokes sueltos apuntan al server real |
| `SMOKE_DIR` | `/tmp/opencode/smoke-*` | directorio scratch de cada smoke |

Cada smoke crea y borra sus propias sesiones en un dir temporal; **nunca toca
sesiones reales**. Los smokes que hacen prompts pueden tardar minutos (timeouts
internos de 180,240 s) y el reasoning part es no-determinista (ver
`smoke-reasoning-only.ts`, que reintenta con prompts inductores).

## Metodología de verificación (lección cara, no repetir)

- **Para verificar qué llega al contexto se miden tokens, no se le pregunta al
  modelo.** Un test conductual dio "dropped" cuando el secreto estaba en el
  `reasoning`; era un *refusal*, no ausencia de contexto. El instrumento de
  `step-finish.tokens.input` (con control positivo `text`) lo desmintió.
- Todo se midió con `--pure` y modelo `litellm/deepseek-v4-flash` (cuando ese modelo no responde, los smokes fijan `litellm/muse-spark-1.3-contributor` o `litellm/gpt-oss-20b` explícito). El reenvío de `reasoning` varía por provider (Anthropic/Bedrock dropean reasoning sin firma).
- Prompt caching y compactación no medidos salvo Q1 snapshot-no-serializado. Ver `docs/02`, `docs/04`.
- Hallazgo task #17: `metadata` no vacío en text/tool rompe el turno siguiente (`ModelMessage[] schema`), documentado en `README.md` limitaciones y `docs/02` end-to-end (cause probe 7 brazos).

## Convenciones

- **Español rioplatense** en toda la documentación interna (voseo, lenguaje corriente). Artefactos públicos (`README.md`, `package.json`, `LICENSE`) en inglés por convención OSS (ver sibling `opencode-delete-messages`).
- **Marcas de estado** en todo artefacto de diseño: ✅ funciona · 🔶 firmado, sin construir · ⚠️ borde/riesgo/supuesto conocido.
- **Doctrina de Autoridad**: la documentación describe el DEBER, no el ES. Un gap entre doc y código se reporta, no se cierra rebajando la doc. Los cuatro puntos cambiados por decisión del owner en `docs/01` citan su DEC/ADR en el lugar.
- Diagramas: un archivo `.mmd` por diagrama (Mermaid puro, sin fence), referenciado desde la prosa; nunca inline.

## Qué NO hacer

- No tocar `snapshot` / `patch` / `step-finish` (reversibilidad de archivos y contabilidad de costo). Un op fuera del allowlist `text`/`reasoning`/`tool` invalida el plan entero (invariante I4).
- No borrar mensajes del medio (ver ADR 0001): arrastra `step-finish`/`snapshot` en cascada y corrompe `/undo`.
- No tocar sesiones reales ni el server de uso diario (`:4096`).
- No usar `npm`/`node` para los scripts: el runtime es Bun.
- No correr `bun test` sin `bun run build` previo (el entry test importa `dist/tui.js`).

## Build y tests

- `bun run build` → `tsc -p tsconfig.json` (`src/` → `dist/` con `.js`/`.d.ts`/maps).
- `bun run typecheck` → `tsc --noEmit && tsc -p tsconfig.test.json`.
- `bun test` → corre `pretest` (build) y luego `bun test` (15 archivos, 223 tests). Todos los tests importan de `src/` (regla hard).
- `npm pack` incluye solo `dist/` + `README.md` + `LICENSE` + `package.json` (`files: ["dist"]`); `scripts/` y `docs/` quedan en git, fuera del tarball.
