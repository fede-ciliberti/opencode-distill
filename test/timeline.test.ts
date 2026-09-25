// Tests del timeline de selección (DEC-5, task #13).
// Failing-first: importan de ../src/pure.js (regla dura).
import { describe, expect, test } from "bun:test"
import {
  buildStretchOptions,
  type AssistantMessageLike,
  type MessageLike,
  type PartLike,
  type UserMessageLike,
} from "../src/pure.js"

function user(id: string): UserMessageLike {
  return { id, role: "user", time: { created: 1 }, parts: [] }
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

function textPart(id: string, messageID: string, text: string): PartLike {
  return { id, sessionID: "s1", messageID, type: "text", text }
}

function reasoningPart(id: string, messageID: string, text: string): PartLike {
  return { id, sessionID: "s1", messageID, type: "reasoning", text }
}

function toolPart(id: string, messageID: string, status: string, output?: string): PartLike {
  return { id, sessionID: "s1", messageID, type: "tool", state: { status, output } }
}

// u1, m1 (15+7+4=26), m2 (25+7+14=46), m3 (summary), m4 (vacío), u2, m5 (11).
function fixtureMessages(): MessageLike[] {
  return [
    user("u1"),
    assistant("m1", [
      textPart("p-t1", "m1", "alpha reply one"),
      reasoningPart("p-r1", "m1", "why one"),
      toolPart("p-o1", "m1", "completed", "out1"),
    ]),
    assistant("m2", [
      textPart("p-t2", "m2", "second message text here!"),
      reasoningPart("p-r2", "m2", "r2think"),
      toolPart("p-o2", "m2", "completed", "tool-output-22"),
    ]),
    assistant("m3", [textPart("p-t3", "m3", "summary of compaction")], true),
    assistant("m4", [
      textPart("p-t4", "m4", ""),
      toolPart("p-o4", "m4", "running", "zzz"),
    ]),
    user("u2"),
    assistant("m5", [textPart("p-t5", "m5", "tail answer")]),
  ]
}

describe("buildStretchOptions presets", () => {
  test("cuatro presets con títulos y valores exactos", () => {
    const { presets } = buildStretchOptions(fixtureMessages(), undefined)
    expect(presets.map((p) => p.title)).toEqual([
      "Current turn",
      "Last 3",
      "Last 5",
      "All assistant messages",
    ])
    expect(presets[0]?.value).toEqual({ kind: "current-turn" })
    expect(presets[1]?.value).toEqual({ kind: "last-n", n: 3 })
    expect(presets[2]?.value).toEqual({ kind: "last-n", n: 5 })
    expect(presets[3]?.value).toEqual({ kind: "range", firstID: "m1", lastID: "m5" })
  })
})

describe("buildStretchOptions rows", () => {
  test("una fila por mensaje elegible con breakdown por tipo", () => {
    const { rows } = buildStretchOptions(fixtureMessages(), undefined)
    // m3 es summary (I7) y m4 no tiene masa → omitidos.
    expect(rows.map((r) => r.title)).toEqual([
      'From m1: "alpha reply one"',
      'From m2: "second message text here!"',
      'From m5: "tail answer"',
    ])
    expect(rows[0]?.description).toBe("text 15 · reasoning 7 · tool 4 (≈7 tok, estimate)")
    expect(rows[1]?.description).toBe("text 25 · reasoning 7 · tool 14 (≈12 tok, estimate)")
    expect(rows[2]?.description).toBe("text 11 · reasoning 0 · tool 0 (≈3 tok, estimate)")
  })

  test("cada fila From X llega hasta el final (el End reusa la lista)", () => {
    const { rows } = buildStretchOptions(fixtureMessages(), undefined)
    expect(rows.map((r) => r.value)).toEqual([
      { kind: "range", firstID: "m1", lastID: "m5" },
      { kind: "range", firstID: "m2", lastID: "m5" },
      { kind: "range", firstID: "m5", lastID: "m5" },
    ])
  })

  test("boundary excluye lo pre-boundary (I7)", () => {
    const { presets, rows } = buildStretchOptions(fixtureMessages(), "m1")
    expect(rows.map((r) => r.title)).toEqual([
      'From m2: "second message text here!"',
      'From m5: "tail answer"',
    ])
    expect(presets[3]?.value).toEqual({ kind: "range", firstID: "m2", lastID: "m5" })
  })

  test("preview trunca a 40 chars", () => {
    const messages: MessageLike[] = [
      user("u1"),
      assistant("mlong", [textPart("p-tl", "mlong", "0123456789".repeat(5))]),
    ]
    const { rows } = buildStretchOptions(messages, undefined)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('From mlong: "0123456789012345678901234567890123456789"')
    expect(rows[0]?.description).toBe("text 50 · reasoning 0 · tool 0 (≈13 tok, estimate)")
  })

  test("mensaje solo-tool entra con preview vacío", () => {
    const messages: MessageLike[] = [
      user("u1"),
      assistant("mtool", [toolPart("p-ot", "mtool", "completed", "0123456789")]),
    ]
    const { rows } = buildStretchOptions(messages, undefined)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('From mtool: ""')
    expect(rows[0]?.description).toBe("text 0 · reasoning 0 · tool 10 (≈3 tok, estimate)")
  })

  test("sin elegibles: preset All vacío y cero filas", () => {
    const { presets, rows } = buildStretchOptions([user("u1")], undefined)
    expect(rows).toEqual([])
    expect(presets[3]?.value).toEqual({ kind: "range", firstID: "", lastID: "" })
  })
})
