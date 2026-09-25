# AGENTS.md — opencode-distill

> Índice de propagación del proyecto. Declara **dónde vive cada cosa** para que
> una sesión nueva pueda retomar sin leer el historial de chat.

## Qué es

Plugin TUI de [opencode](https://github.com/anomalyco/opencode) para **destilar
tramos descarrilados de una sesión in-place**: reescribe partes de mensajes
(`text`, `reasoning`, `tool.output`) para acortar y abaratar los turnos futuros,
sin compactar todo ni forkear.

## Estado

🔶 **Diseño firmado, pendiente de construir.** No hay código de plugin todavía;
sí hay documentación y scripts de evidencia. **El repo no tiene ningún commit**
(`git log` falla con "does not have any commits yet"); no asumir historia.

## Stack

- OpenCode **1.18.32** (binario en `~/.opencode/bin/opencode`), SDK v2
  (`@opencode-ai/sdk@1.18.32`), plugin TUI.
- **Runtime = Bun 1.3.2** (no Node). Los scripts son `.ts` ejecutados directo por
  `bun run`; `@types/bun` es la única fuente de tipos. Usar `bun install`, no
  `npm install`.

## Índice de propagación (fuente de verdad)

| Concepto | Fuente de verdad |
|---|---|
| Diseño del mecanismo (modelo de datos, invariantes, algoritmo, MVP) | [`docs/01-diseño.md`](docs/01-diseño.md) |
| Primitivas verificadas (qué acepta el server) | [`docs/02-hallazgos-empiricos.md`](docs/02-hallazgos-empiricos.md) |
| Cómo OpenCode arma el contexto (internals) | [`docs/03-investigacion-opencode.md`](docs/03-investigacion-opencode.md) |
| Backlog de verificación | [`docs/04-preguntas-abiertas.md`](docs/04-preguntas-abiertas.md) |
| Decisiones de arquitectura | [`docs/adr/`](docs/adr/) |
| Diagramas (Mermaid puro, `.mmd`) | [`docs/diagrams/`](docs/diagrams/) — hoy `flujo-distill.mmd` |
| Evidencia reproducible (smokes) | [`scripts/`](scripts/) |

## Cómo reproducir la evidencia

```bash
bun install                                              # baja el SDK (devDependency)
scripts/run-smoke.sh scripts/smoke-part-update.ts        # harness: levanta server y corre el smoke
```

**`run-smoke.sh` es el harness, no los `smoke:*` de `package.json`.** Los scripts
npm corren el smoke contra el default `http://127.0.0.1:4096`, que es el server de
uso diario con Basic auth — **el target equivocado**. El harness usa
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
internos de 180–240 s) y el reasoning part es no-determinista (ver
`smoke-reasoning-only.ts`, que reintenta con prompts inductores).

## Metodología de verificación (lección cara, no repetir)

- **Para verificar qué llega al contexto se miden tokens, no se le pregunta al
  modelo.** Un test conductual dio "dropped" cuando el secreto estaba en el
  `reasoning`; era un *refusal*, no ausencia de contexto. El instrumento de
  `step-finish.tokens.input` (con control positivo `text`) lo desmintió.
- Todo se midió con `--pure` y modelo `litellm/deepseek-v4-flash`. El reenvío de
  `reasoning` varía por provider (Anthropic/Bedrock dropean reasoning sin firma).
- No medido aún: prompt caching, compactación. Ver `docs/04-preguntas-abiertas.md`.

## Convenciones

- **Español rioplatense** en toda la documentación (voseo, lenguaje corriente).
- **Marcas de estado** en todo artefacto de diseño: ✅ funciona · 🔶 firmado, sin
  construir · ⚠️ borde/riesgo/supuesto conocido.
- **Doctrina de Autoridad**: la documentación describe el DEBER, no el ES. Un gap
  entre doc y código se reporta, no se cierra rebajando la doc.
- Diagramas: un archivo `.mmd` por diagrama (Mermaid puro, sin fence), referenciado
  desde la prosa; nunca inline.

## Qué NO hacer

- No tocar `snapshot` / `patch` / `step-finish` (reversibilidad de archivos y
  contabilidad de costo). Un op fuera del allowlist `text`/`reasoning`/`tool`
  invalida el plan entero (invariante I4).
- No borrar mensajes del medio (ver ADR 0001): arrastra `step-finish`/`snapshot`
  en cascada y corrompe `/undo`.
- No tocar sesiones reales ni el server de uso diario (`:4096`).
- No usar `npm`/`node` para los scripts: el runtime es Bun.
