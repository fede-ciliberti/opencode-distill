# opencode-distill

Plugin TUI de [opencode](https://github.com/anomalyco/opencode) para **destilar tramos descarrilados de una sesión in-place**: reescribe partes de mensajes (`text`, `reasoning`, `tool.output`) para acortar y abaratar los turnos futuros, sin compactar todo (global) ni forkear (descarta lo posterior).

## Estado

🔶 Diseño firmado, pendiente de construir. Todavía sin código de plugin.

**Empezá por [`AGENTS.md`](AGENTS.md)** (índice de propagación: dónde vive cada cosa).

- [`docs/01-diseño.md`](docs/01-diseño.md) — diseño del mecanismo.
- [`docs/02-hallazgos-empiricos.md`](docs/02-hallazgos-empiricos.md) — qué acepta el server (verificado).
- [`docs/03-investigacion-opencode.md`](docs/03-investigacion-opencode.md) — cómo arma el contexto OpenCode.
- [`docs/04-preguntas-abiertas.md`](docs/04-preguntas-abiertas.md) — backlog de verificación.
- [`docs/adr/0001-reescritura-a-nivel-de-parte.md`](docs/adr/0001-reescritura-a-nivel-de-parte.md) — decisión central.
- [`scripts/`](scripts/) — evidencia reproducible (smokes).

## Idea

Cuando una depuración larga llega al punto, el derrotero previo ensucia el contexto. `/distill` reemplaza ese tramo por una versión destilada y coherente —preservando decisiones y resultados negativos— y deja el resto de la sesión intacto.

El registro de lo descartado va a un *trace* en disco (`.opencode/distill/`); el restore se hace con `/distill-restore`.
