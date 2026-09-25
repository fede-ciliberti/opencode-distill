// Tests de selección de stretch y tipos (diseño §3 + §4, task #6).
// Failing-first: importan de ../src/pure.js (regla dura).
import { describe, expect, test } from "bun:test"
import {
  MIN_STRETCH_CHARS,
  charsByType,
  findCompactionBoundary,
  parseTypeSpec,
  selectStretch,
  selectedChars,
  type AssistantMessageLike,
  type MessageLike,
  type PartLike,
  type PartTypeName,
  type TypeFilter,
  type UserMessageLike,
} from "../src/pure.js"

// Helpers: formas mínimas W0 (compaction vive en mensaje user).
function user(id: string, parts: readonly PartLike[] = []): UserMessageLike {
  return { id, role: "user", time: { created: 1 }, parts }
}

function assistant(
  id: string,
  parts: readonly PartLike[] = [],
  summary?: boolean,
): AssistantMessageLike {
  return summary === true
    ? { id, role: "assistant", time: { created: 1 }, summary: true, parts }
    : { id, role: "assistant", time: { created: 1 }, parts }
}

function textPart(id: string, text: string): PartLike {
  return { id, sessionID: "s1", messageID: "m", type: "text", text }
}

function reasoningPart(id: string, text: string): PartLike {
  return { id, sessionID: "s1", messageID: "m", type: "reasoning", text }
}

function toolPart(
  id: string,
  status: string,
  output?: string,
  error?: string,
): PartLike {
  return { id, sessionID: "s1", messageID: "m", type: "tool", state: { status, output, error } }
}

function bigText(id: string, chars = 600): PartLike {
  return textPart(id, "x".repeat(chars))
}

function bigAssistant(id: string, chars = 600): AssistantMessageLike {
  return assistant(id, [{ ...bigText("p-" + id, chars), messageID: id }])
}

const ALL: TypeFilter = new Set<PartTypeName>(["text", "reasoning", "tool"])

describe("parseTypeSpec", () => {
  test("un tipo válido", () => {
    expect(parseTypeSpec("text")).toEqual(new Set(["text"]))
  })

  test("varios tipos separados por coma+espacio", () => {
    expect(parseTypeSpec("text, reasoning")).toEqual(new Set(["text", "reasoning"]))
  })

  test("case-insensitive y trim", () => {
    expect(parseTypeSpec("  TEXT , Reasoning ")).toEqual(new Set(["text", "reasoning"]))
  })

  test("duplicados colapsan", () => {
    const got = parseTypeSpec("text,text, text")
    expect(got).toEqual(new Set(["text"]))
    if (!(got instanceof Set)) throw new Error("esperaba un Set")
    expect(got.size).toBe(1)
  })

  test("token fuera del allowlist → invalid", () => {
    expect(parseTypeSpec("text,snapshot")).toEqual({ kind: "invalid" })
  })

  test("string vacío → invalid", () => {
    expect(parseTypeSpec("")).toEqual({ kind: "invalid" })
  })

  test("solo whitespace → invalid", () => {
    expect(parseTypeSpec("   ")).toEqual({ kind: "invalid" })
  })
})

describe("charsByType", () => {
  test("suma text", () => {
    expect(charsByType([textPart("a", "abc"), textPart("b", "de")])).toEqual({
      text: 5,
      reasoning: 0,
      tool: 0,
    })
  })

  test("suma reasoning", () => {
    expect(charsByType([reasoningPart("a", "abcd")])).toEqual({
      text: 0,
      reasoning: 4,
      tool: 0,
    })
  })

  test("tool completed cuenta output", () => {
    expect(charsByType([toolPart("a", "completed", "out123")])).toEqual({
      text: 0,
      reasoning: 0,
      tool: 6,
    })
  })

  test("tool error cuenta el string de error", () => {
    expect(charsByType([toolPart("a", "error", undefined, "boom")])).toEqual({
      text: 0,
      reasoning: 0,
      tool: 4,
    })
  })

  test("tool pending/running = 0", () => {
    expect(
      charsByType([toolPart("a", "pending", "zzz"), toolPart("b", "running", "yyy")]),
    ).toEqual({ text: 0, reasoning: 0, tool: 0 })
  })

  test("mixto + parte fuera del allowlist = 0", () => {
    const parts: PartLike[] = [
      textPart("a", "ab"),
      reasoningPart("b", "cde"),
      toolPart("c", "completed", "wxyz"),
      { id: "d", sessionID: "s1", messageID: "m", type: "snapshot" },
      { id: "e", sessionID: "s1", messageID: "m", type: "file", text: "no-count" },
    ]
    expect(charsByType(parts)).toEqual({ text: 2, reasoning: 3, tool: 4 })
  })
})

describe("selectedChars", () => {
  test("subconjunto de tipos", () => {
    const parts = [textPart("a", "ab"), reasoningPart("b", "cde")]
    expect(selectedChars(parts, new Set<PartTypeName>(["text"]))).toBe(2)
    expect(selectedChars(parts, new Set<PartTypeName>(["reasoning"]))).toBe(3)
    expect(selectedChars(parts, ALL)).toBe(5)
  })
})

describe("findCompactionBoundary", () => {
  test("sin compaction → undefined", () => {
    const messages: MessageLike[] = [user("u1"), bigAssistant("a1")]
    expect(findCompactionBoundary(messages)).toBeUndefined()
  })

  test("última de varias (compaction vive en user, forma W0)", () => {
    const c1: PartLike = { id: "c1", sessionID: "s1", messageID: "u1", type: "compaction" }
    const c2: PartLike = { id: "c2", sessionID: "s1", messageID: "u2", type: "compaction" }
    const messages: MessageLike[] = [user("u1", [c1]), bigAssistant("a1"), user("u2", [c2])]
    expect(findCompactionBoundary(messages)).toBe("u2")
  })
})

describe("selectStretch current-turn", () => {
  test("happy: todo lo posterior al último user", () => {
    const messages: MessageLike[] = [user("u1"), bigAssistant("a1"), bigAssistant("a2")]
    const got = selectStretch(messages, { kind: "current-turn" }, undefined, ALL)
    expect(got).toEqual({ ok: true, messageIDs: ["a1", "a2"] })
  })

  test("sin user → toda la lista", () => {
    const messages: MessageLike[] = [bigAssistant("a1"), bigAssistant("a2")]
    const got = selectStretch(messages, { kind: "current-turn" }, undefined, ALL)
    expect(got).toEqual({ ok: true, messageIDs: ["a1", "a2"] })
  })

  test("último mensaje es user → empty-stretch", () => {
    const messages: MessageLike[] = [bigAssistant("a1"), user("u1")]
    const got = selectStretch(messages, { kind: "current-turn" }, undefined, ALL)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.kind).toBe("empty-stretch")
  })
})

describe("selectStretch last-n", () => {
  test("happy: últimos 2 assistants", () => {
    const messages: MessageLike[] = [
      user("u1"),
      bigAssistant("a1"),
      user("u2"),
      bigAssistant("a2"),
      bigAssistant("a3"),
    ]
    const got = selectStretch(messages, { kind: "last-n", n: 2 }, undefined, ALL)
    expect(got).toEqual({ ok: true, messageIDs: ["a2", "a3"] })
  })

  test("n mayor que disponibles → not-enough-messages", () => {
    const messages: MessageLike[] = [user("u1"), bigAssistant("a1")]
    const got = selectStretch(messages, { kind: "last-n", n: 5 }, undefined, ALL)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.kind).toBe("not-enough-messages")
  })

  test("n < 1 → not-enough-messages", () => {
    const messages: MessageLike[] = [bigAssistant("a1")]
    const got = selectStretch(messages, { kind: "last-n", n: 0 }, undefined, ALL)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.kind).toBe("not-enough-messages")
  })

  test("user posterior al último assistant no rompe el span", () => {
    const messages: MessageLike[] = [
      user("u1"),
      bigAssistant("a1"),
      bigAssistant("a2"),
      user("u2"),
    ]
    const got = selectStretch(messages, { kind: "last-n", n: 2 }, undefined, ALL)
    expect(got).toEqual({ ok: true, messageIDs: ["a1", "a2"] })
  })

  test("user entre los últimos n → stretch-crosses-user-message", () => {
    const messages: MessageLike[] = [
      bigAssistant("a1"),
      user("u1"),
      bigAssistant("a2"),
    ]
    const got = selectStretch(messages, { kind: "last-n", n: 2 }, undefined, ALL)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.kind).toBe("stretch-crosses-user-message")
  })
})

describe("selectStretch range", () => {
  test("happy", () => {
    const messages: MessageLike[] = [
      user("u1"),
      bigAssistant("a1"),
      bigAssistant("a2"),
      bigAssistant("a3"),
    ]
    const got = selectStretch(
      messages,
      { kind: "range", firstID: "a1", lastID: "a2" },
      undefined,
      ALL,
    )
    expect(got).toEqual({ ok: true, messageIDs: ["a1", "a2"] })
  })

  test("reversed se normaliza con min/max", () => {
    const messages: MessageLike[] = [
      user("u1"),
      bigAssistant("a1"),
      bigAssistant("a2"),
    ]
    const got = selectStretch(
      messages,
      { kind: "range", firstID: "a2", lastID: "a1" },
      undefined,
      ALL,
    )
    expect(got).toEqual({ ok: true, messageIDs: ["a1", "a2"] })
  })

  test("id inexistente → message-not-found", () => {
    const messages: MessageLike[] = [bigAssistant("a1")]
    const got = selectStretch(
      messages,
      { kind: "range", firstID: "a1", lastID: "nope" },
      undefined,
      ALL,
    )
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.kind).toBe("message-not-found")
  })

  test("rango que abarca un user → stretch-crosses-user-message", () => {
    const messages: MessageLike[] = [
      bigAssistant("a1"),
      user("u1"),
      bigAssistant("a2"),
    ]
    const got = selectStretch(
      messages,
      { kind: "range", firstID: "a1", lastID: "a2" },
      undefined,
      ALL,
    )
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.kind).toBe("stretch-crosses-user-message")
  })

  test("rango entero antes del boundary → stretch-behind-compaction", () => {
    const c: PartLike = { id: "c", sessionID: "s1", messageID: "u9", type: "compaction" }
    const messages: MessageLike[] = [
      bigAssistant("a1"),
      bigAssistant("a2"),
      user("u9", [c]),
      user("u10"),
      bigAssistant("a3"),
    ]
    const got = selectStretch(
      messages,
      { kind: "range", firstID: "a1", lastID: "a2" },
      "u9",
      ALL,
    )
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.kind).toBe("stretch-behind-compaction")
  })
})

describe("selectStretch guards", () => {
  test("summary dentro → stretch-contains-summary", () => {
    const messages: MessageLike[] = [
      user("u1"),
      assistant("a1", [{ ...bigText("p1"), messageID: "a1" }], true),
      bigAssistant("a2"),
    ]
    const got = selectStretch(messages, { kind: "current-turn" }, undefined, ALL)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.kind).toBe("stretch-contains-summary")
  })

  test("parte compaction dentro → stretch-contains-compaction", () => {
    const c: PartLike = { id: "c", sessionID: "s1", messageID: "a1", type: "compaction" }
    const messages: MessageLike[] = [
      user("u1"),
      assistant("a1", [{ ...bigText("p1"), messageID: "a1" }, c]),
      bigAssistant("a2"),
    ]
    const got = selectStretch(messages, { kind: "current-turn" }, undefined, ALL)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.kind).toBe("stretch-contains-compaction")
  })

  test("masa seleccionada 0 → no-distillable-content", () => {
    const messages: MessageLike[] = [
      user("u1"),
      assistant("a1", [
        { id: "f", sessionID: "s1", messageID: "a1", type: "file" },
      ]),
    ]
    const got = selectStretch(messages, { kind: "current-turn" }, undefined, ALL)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.kind).toBe("no-distillable-content")
  })

  test("masa bajo MIN_STRETCH_CHARS → stretch-too-small", () => {
    const messages: MessageLike[] = [user("u1"), assistant("a1", [textPart("p1", "corto")])]
    const fixed = messages.map((m) =>
      m.role === "assistant" && m.id === "a1"
        ? { ...m, parts: [{ ...textPart("p1", "corto"), messageID: "a1" }] }
        : m,
    )
    const got = selectStretch(fixed, { kind: "current-turn" }, undefined, ALL)
    expect(got.ok).toBe(false)
    if (!got.ok) {
      expect(got.kind).toBe("stretch-too-small")
      expect(MIN_STRETCH_CHARS).toBe(500)
    }
  })

  test("too-small depende de los tipos: reasoning 300 solo falla, con text ≥500 pasa", () => {
    const mk = (): MessageLike[] => [
      user("u1"),
      assistant("a1", [
        { ...reasoningPart("r", "r".repeat(300)), messageID: "a1" },
        { ...textPart("t", "t".repeat(300)), messageID: "a1" },
      ]),
    ]
    const onlyReasoning = selectStretch(
      mk(),
      { kind: "current-turn" },
      undefined,
      new Set<PartTypeName>(["reasoning"]),
    )
    expect(onlyReasoning.ok).toBe(false)
    if (!onlyReasoning.ok) expect(onlyReasoning.kind).toBe("stretch-too-small")
    const combined = selectStretch(
      mk(),
      { kind: "current-turn" },
      undefined,
      new Set<PartTypeName>(["text", "reasoning"]),
    )
    expect(combined).toEqual({ ok: true, messageIDs: ["a1"] })
  })
})
