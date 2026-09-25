// Tests del destilador: prompt, transcript, parser y validador (diseño §5, task #9).
// Failing-first: importan de ../src/distill.js (regla dura: importan código real).
import { describe, expect, test } from "bun:test"
import {
  buildBudget,
  buildDistillPrompt,
  buildTranscript,
  estTokens,
  parseDistillOutput,
  userRequestFor,
  type DistillPartLike,
} from "../src/distill.js"
import type {
  MessageLike,
  PartLike,
  PartTypeName,
  Stretch,
  TypeFilter,
} from "../src/pure.js"

// Helpers mínimos.
function textPart(id: string, messageID: string, text: string): PartLike {
  return { id, sessionID: "s1", messageID, type: "text", text }
}

function reasoningPart(id: string, messageID: string, text: string): PartLike {
  return { id, sessionID: "s1", messageID, type: "reasoning", text }
}

function toolPart(
  id: string,
  messageID: string,
  tool: string,
  input: unknown,
  output: string,
): DistillPartLike {
  return {
    id,
    sessionID: "s1",
    messageID,
    type: "tool",
    tool,
    state: { status: "completed", input, output },
  }
}

function filePart(id: string, messageID: string): PartLike {
  return { id, sessionID: "s1", messageID, type: "file" }
}

function typesOf(...names: readonly PartTypeName[]): TypeFilter {
  return new Set<PartTypeName>(names)
}

const ALL = typesOf("text", "reasoning", "tool")

function userMsg(id: string, text: string): MessageLike {
  return {
    id,
    role: "user",
    time: { created: 1 },
    parts: [{ id: `p-${id}`, sessionID: "s1", messageID: id, type: "text", text }],
  }
}

function assistantMsg(id: string, parts: readonly PartLike[]): MessageLike {
  return { id, role: "assistant", time: { created: 1 }, parts }
}

function stretchOf(...messageIDs: readonly string[]): Stretch {
  return { sessionID: "s1", directory: "/tmp/x", messageIDs }
}

describe("estTokens", () => {
  test("ceil(chars/4): 0→0, 1→1, 4→1, 5→2, 100→25", () => {
    expect(estTokens(0)).toBe(0)
    expect(estTokens(1)).toBe(1)
    expect(estTokens(4)).toBe(1)
    expect(estTokens(5)).toBe(2)
    expect(estTokens(100)).toBe(25)
  })
})

describe("buildBudget", () => {
  test("25% de la masa con techo 1024", () => {
    // 1600 chars → 400 tokens → 25% = 100.
    expect(buildBudget(1600)).toBe(100)
    expect(buildBudget(400)).toBe(25)
    expect(buildBudget(0)).toBe(0)
  })

  test("techo en 1024 tokens", () => {
    expect(buildBudget(1_000_000)).toBe(1024)
  })
})

describe("buildTranscript", () => {
  test("happy: bloques numerados con texto verbatim, reasoning con prefijo y tool con input/output", () => {
    const parts: readonly DistillPartLike[] = [
      textPart("p1", "m1", "hello"),
      reasoningPart("p2", "m1", "thinking"),
      toolPart("p3", "m1", "read", { path: "a" }, "content"),
      textPart("p4", "m2", "done"),
    ]
    const out = buildTranscript(parts, ["m1", "m2"], ALL)
    expect(out).toBe(
      `[1] assistant\nhello\n[reasoning] thinking\ntool read\ninput: {"path":"a"}\ncontent\n\n[2] assistant\ndone`,
    )
  })

  test("filtra tipos no seleccionados: con solo text, reasoning y tool no aparecen", () => {
    const parts: readonly DistillPartLike[] = [
      textPart("p1", "m1", "hello"),
      reasoningPart("p2", "m1", "secret-thinking"),
      toolPart("p3", "m1", "read", { path: "a" }, "secret-output"),
    ]
    const out = buildTranscript(parts, ["m1"], typesOf("text"))
    expect(out).toBe("[1] assistant\nhello")
    expect(out).not.toContain("secret-thinking")
    expect(out).not.toContain("secret-output")
    expect(out).not.toContain("tool read")
  })

  test("mensaje sin partes seleccionadas → bloque (no selected content)", () => {
    const parts: readonly PartLike[] = [filePart("p1", "m1")]
    const out = buildTranscript(parts, ["m1"], ALL)
    expect(out).toBe("[1] assistant (no selected content)")
  })

  test("numeración 1..n alineada al orden de messageIDs", () => {
    const parts: readonly PartLike[] = [
      textPart("p1", "mb", "second"),
      textPart("p2", "ma", "first"),
    ]
    const out = buildTranscript(parts, ["ma", "mb"], typesOf("text"))
    expect(out).toBe("[1] assistant\nfirst\n\n[2] assistant\nsecond")
  })
})

describe("buildDistillPrompt", () => {
  test("incluye prompt verbatim, budget interpolado, scope, request y transcript", () => {
    const prompt = buildDistillPrompt(
      "[1] assistant\nhello",
      "fix the bug",
      100,
      typesOf("text", "reasoning"),
    )
    // Verbatim del diseño §5.2.
    expect(prompt).toContain("MUST keep:")
    expect(prompt).toContain("MUST drop:")
    expect(prompt).toContain("Format (strict, no preamble):")
    expect(prompt).toContain("<distillate>")
    expect(prompt).toContain("<stubs>")
    expect(prompt).toContain("<n>: <≤15 words, past tense, what message n did>")
    // Budget interpolado, sin placeholder crudo.
    expect(prompt).toContain("distillate ≤ 100 tokens")
    expect(prompt).not.toContain("<budget>")
    // Scope line según tipos.
    expect(prompt).toContain("You are distilling only: text, reasoning")
    // Request y transcript embebidos.
    expect(prompt).toContain("fix the bug")
    expect(prompt).toContain("[1] assistant\nhello")
  })

  test("no hardcodea messageIDs y el scope cubre tool outputs", () => {
    const prompt = buildDistillPrompt("[1] assistant\nx", "(none)", 50, ALL)
    expect(prompt).not.toContain("msg-")
    expect(prompt).toContain("You are distilling only: text, reasoning, tool outputs")
  })
})

const GOOD_RAW = `<distillate>
## Outcome
Fixed the bug.
## Ruled out
- cache — stale entry evidence
## Key facts
- src/a.ts:1 — root cause line
## Open
- none
</distillate>
<stubs>
1: Investigated the failing test suite
2: Applied the one-line fix
</stubs>`

function budgetFor(raw: string): number {
  const inner = raw.split("<distillate>")[1]?.split("</distillate>")[0] ?? ""
  return estTokens(inner.trim().length)
}

describe("parseDistillOutput", () => {
  test("happy: extrae summary y stubs mapeados a messageIDs", () => {
    const res = parseDistillOutput(GOOD_RAW, ["m1", "m2"], budgetFor(GOOD_RAW))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.distillate.summary).toContain("## Outcome")
      expect(res.distillate.summary).toContain("Fixed the bug.")
      expect(res.distillate.stubs).toEqual({
        m1: "Investigated the failing test suite",
        m2: "Applied the one-line fix",
      })
    }
  })

  test("stubs mapean por ORDEN: stub 1 → primer ID del stretch", () => {
    const res = parseDistillOutput(GOOD_RAW, ["mB", "mA"], budgetFor(GOOD_RAW))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.distillate.stubs).toEqual({
        mB: "Investigated the failing test suite",
        mA: "Applied the one-line fix",
      })
    }
  })

  test("budget excedido → ok:false", () => {
    const res = parseDistillOutput(GOOD_RAW, ["m1", "m2"], 1)
    expect(res.ok).toBe(false)
  })

  test("stubs incompletos (falta un mensaje) → ok:false", () => {
    const raw = GOOD_RAW.replace("2: Applied the one-line fix", "")
    const res = parseDistillOutput(raw, ["m1", "m2"], budgetFor(raw))
    expect(res.ok).toBe(false)
  })

  test("stubs de más (extra) → ok:false", () => {
    const raw = GOOD_RAW.replace(
      "2: Applied the one-line fix",
      "2: Applied the one-line fix\n3: Did something else",
    )
    const res = parseDistillOutput(raw, ["m1", "m2"], budgetFor(raw))
    expect(res.ok).toBe(false)
  })

  test("tags faltantes → ok:false", () => {
    const res = parseDistillOutput("no tags here", ["m1"], 100)
    expect(res.ok).toBe(false)
    const res2 = parseDistillOutput("<distillate>x</distillate>", ["m1"], 100)
    expect(res2.ok).toBe(false)
  })

  test("distillate vacío → ok:false", () => {
    const raw = "<distillate>   \n  </distillate>\n<stubs>\n1: Did the work\n</stubs>"
    const res = parseDistillOutput(raw, ["m1"], 100)
    expect(res.ok).toBe(false)
  })

  test("stub de más de 15 palabras → ok:false", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen"
    const raw = `<distillate>\n## Outcome\nDone.\n</distillate>\n<stubs>\n1: ${long}\n</stubs>`
    const res = parseDistillOutput(raw, ["m1"], 100)
    expect(res.ok).toBe(false)
  })

  test("stub n fuera de rango (0 y n+1) → ok:false", () => {
    const zero = GOOD_RAW.replace("1: Investigated the failing test suite", "0: Investigated the suite")
    expect(parseDistillOutput(zero, ["m1", "m2"], budgetFor(zero)).ok).toBe(false)
    const over = GOOD_RAW.replace("1: Investigated the failing test suite", "9: Investigated the suite")
    expect(parseDistillOutput(over, ["m1", "m2"], budgetFor(over)).ok).toBe(false)
  })
})

describe("userRequestFor", () => {
  test("texto del último user antes del stretch", () => {
    const messages: readonly MessageLike[] = [
      userMsg("u1", "first request"),
      assistantMsg("m1", [textPart("p1", "m1", "work")]),
      userMsg("u2", "fix the bug"),
      assistantMsg("m2", [textPart("p2", "m2", "more work")]),
    ]
    expect(userRequestFor(messages, stretchOf("m2"))).toBe("fix the bug")
  })

  test("sin user previo → (none)", () => {
    const messages: readonly MessageLike[] = [
      assistantMsg("m1", [textPart("p1", "m1", "work")]),
    ]
    expect(userRequestFor(messages, stretchOf("m1"))).toBe("(none)")
  })
})
