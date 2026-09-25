// Tests de estimaciones honestas y mensajes de confirmación (D11, DEC-5, task #13).
// Failing-first: importan de ../src/pure.js (regla dura).
import { describe, expect, test } from "bun:test"
import {
  buildConfirmMessage,
  buildEstimates,
  buildReportToast,
  buildRestoreConfirmMessage,
  buildTypeBreakdown,
  buildTypeOptions,
  parseTypeSpec,
  type DistillEstimates,
  type PartLike,
  type PartTypeName,
  type TypeFilter,
  type TypeOptionValue,
} from "../src/pure.js"

const ALL: TypeFilter = new Set<PartTypeName>(["text", "reasoning", "tool"])
const REASONING_ONLY: TypeFilter = new Set<PartTypeName>(["reasoning"])

// Fixture de masa conocida: text 15 + reasoning 7 + tool 4 = 26 chars (≈7 tok).
function fixtureParts(): PartLike[] {
  return [
    { id: "p-t", sessionID: "s1", messageID: "m1", type: "text", text: "alpha reply one" },
    { id: "p-r", sessionID: "s1", messageID: "m1", type: "reasoning", text: "why one" },
    {
      id: "p-o",
      sessionID: "s1",
      messageID: "m1",
      type: "tool",
      state: { status: "completed", output: "out1" },
    },
  ]
}

function setContents(value: TypeOptionValue): readonly string[] {
  if (typeof value === "object" && "custom" in value) return ["custom"]
  if (typeof value === "object" && "has" in value) {
    const out: string[] = []
    for (const t of ["reasoning", "text", "tool"] as const) {
      if ((value as TypeFilter).has(t)) out.push(t)
    }
    return out
  }
  throw new Error("unexpected TypeOption value shape")
}

describe("buildTypeOptions", () => {
  test("cinco presets con títulos exactos y valores estables", () => {
    const first = buildTypeOptions()
    const second = buildTypeOptions()
    expect(first.map((o) => o.title)).toEqual([
      "Everything (text + reasoning + tool outputs)",
      "Everything but tool outputs",
      "Reasoning only",
      "Tool outputs only",
      "Custom…",
    ])
    // Estable: dos llamadas devuelven el mismo contenido.
    expect(second.map((o) => o.title)).toEqual(first.map((o) => o.title))
    expect(first.map((o) => setContents(o.value))).toEqual(
      second.map((o) => setContents(o.value)),
    )
    expect(first.map((o) => setContents(o.value))).toEqual([
      ["reasoning", "text", "tool"],
      ["reasoning", "text"],
      ["reasoning"],
      ["tool"],
      ["custom"],
    ])
  })

  test("Custom… conecta con parseTypeSpec (task #6)", () => {
    const custom = buildTypeOptions()[4]
    expect(custom?.title).toBe("Custom…")
    expect(custom?.value).toEqual({ custom: true })
    const parsed = parseTypeSpec("text reasoning")
    expect(parsed instanceof Set).toBe(true)
    if (parsed instanceof Set) {
      expect(parsed.has("text")).toBe(true)
      expect(parsed.has("reasoning")).toBe(true)
      expect(parsed.has("tool")).toBe(false)
    }
  })
})

describe("buildTypeBreakdown", () => {
  test("todo seleccionado, sin reasoning-suffix cuando no hay reasoning", () => {
    const textOnly: TypeFilter = new Set<PartTypeName>(["text"])
    expect(buildTypeBreakdown(fixtureParts(), textOnly)).toBe(
      "text 15 + reasoning 0 + tool 0 chars selected (≈4 tokens, estimate)",
    )
  })

  test("all types con breakdown exacto por tipo", () => {
    expect(buildTypeBreakdown(fixtureParts(), ALL)).toBe(
      "text 15 + reasoning 7 + tool 4 chars selected (≈7 tokens, estimate) — reasoning savings are provider-dependent",
    )
  })

  test("reasoning-only agrega el suffix provider-dependent", () => {
    expect(buildTypeBreakdown(fixtureParts(), REASONING_ONLY)).toBe(
      "text 0 + reasoning 7 + tool 0 chars selected (≈2 tokens, estimate) — reasoning savings are provider-dependent",
    )
  })
})

describe("buildEstimates", () => {
  test("fórmulas fijas con valores hardcodeados", () => {
    const estimates = buildEstimates(1000, 200, 300, "m1")
    // saving = ceil(800/4) = 200; one-time = ceil(500/4) = 125; break-even = ceil(125/200) = 1.
    expect(estimates).toEqual({
      cacheInvalidationFrom: "m1",
      oneTimeRepriceTokens: 125,
      savingPerTurnTokens: 200,
      estBreakEvenTurns: 1,
    })
  })

  test("break-even de varios turnos", () => {
    const estimates = buildEstimates(1000, 900, 100, "m7")
    // saving = ceil(100/4) = 25; one-time = ceil(1000/4) = 250; break-even = ceil(250/25) = 10.
    expect(estimates.savingPerTurnTokens).toBe(25)
    expect(estimates.oneTimeRepriceTokens).toBe(250)
    expect(estimates.estBreakEvenTurns).toBe(10)
    expect(estimates.cacheInvalidationFrom).toBe("m7")
  })

  test("ahorro 0 usa max(1,…) en vez de dividir por cero", () => {
    const estimates = buildEstimates(400, 400, 100, "m2")
    // saving = ceil(0/4) = 0 → divisor max(1, 0) = 1; one-time = ceil(500/4) = 125.
    expect(estimates.savingPerTurnTokens).toBe(0)
    expect(estimates.oneTimeRepriceTokens).toBe(125)
    expect(estimates.estBreakEvenTurns).toBe(125)
  })
})

describe("buildConfirmMessage", () => {
  test("cinco líneas exactas en inglés, char por char", () => {
    const estimates: DistillEstimates = {
      cacheInvalidationFrom: "m1",
      oneTimeRepriceTokens: 125,
      savingPerTurnTokens: 200,
      estBreakEvenTurns: 1,
    }
    const breakdown =
      "text 15 + reasoning 7 + tool 4 chars selected (≈7 tokens, estimate) — reasoning savings are provider-dependent"
    const message = buildConfirmMessage(
      { firstID: "m1", lastID: "m3" },
      3,
      breakdown,
      1000,
      200,
      estimates,
    )
    expect(message).toBe(
      [
        "Distill 3 assistant messages (m1..m3)?",
        breakdown,
        "Context: 1000 chars → 200 chars (≈200 tokens saved, estimate)",
        "Prompt cache: one-time reprice ≈125 tokens; breaks even after ≈1 turns (estimate)",
        "Originals are preserved in a local trace; /distill-restore undoes this.",
      ].join("\n"),
    )
    expect(message.split("\n")).toHaveLength(5)
  })
})

describe("buildRestoreConfirmMessage", () => {
  test("fecha ISO + cantidad, dos líneas exactas", () => {
    const message = buildRestoreConfirmMessage({
      createdAt: 1790294400000,
      stretch: ["m1", "m2"],
    })
    expect(message).toBe(
      [
        "Restore distillation from 2026-09-25T00:00:00.000Z (2 messages)?",
        "This rewrites the session back to the original content from the trace.",
      ].join("\n"),
    )
  })
})

describe("buildReportToast", () => {
  test("ahorro en chars + tokens estimados", () => {
    // 1000 − 200 = 800 chars; ceil(800/4) = 200 tokens.
    expect(buildReportToast(3, 1000, 200)).toBe(
      "Distilled 3 messages — ~800 chars saved (≈200 tokens, estimate)",
    )
  })
})
