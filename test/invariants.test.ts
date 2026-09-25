// Simulación de invariantes I1–I8 + hashes anti-drift (task #8).
// Failing-first: importan de ../src/pure.js (regla dura).
import { describe, expect, test } from "bun:test"
import {
  buildRewritePlan,
  partHash,
  simulatePlan,
  snapshotForTrace,
  stableStringify,
  type PartLike,
  type PartOp,
  type PartTypeName,
  type RewritePlan,
  type Stretch,
  type TypeFilter,
} from "../src/pure.js"

// Helpers (mismo patrón que plan.test.ts).
function textPart(id: string, messageID: string, text: string, sessionID = "s1"): PartLike {
  return { id, sessionID, messageID, type: "text", text }
}
function reasoningPart(id: string, messageID: string, text: string, sessionID = "s1"): PartLike {
  return { id, sessionID, messageID, type: "reasoning", text }
}
type Toolish = PartLike & { tool?: string }
function toolPart(
  id: string,
  messageID: string,
  tool: string,
  status: string,
  output?: string,
  sessionID = "s1",
): PartLike {
  const part: Toolish = { id, sessionID, messageID, type: "tool", state: { status, output }, tool }
  return part
}
function oddPart(id: string, messageID: string, type: string, sessionID = "s1"): PartLike {
  return { id, sessionID, messageID, type }
}
function typesOf(...names: readonly PartTypeName[]): TypeFilter {
  return new Set<PartTypeName>(names)
}
function stretchOf(sessionID: string, ...messageIDs: readonly string[]): Stretch {
  return { sessionID, directory: "/tmp/x", messageIDs }
}
function partsMap(entries: ReadonlyArray<readonly [string, readonly PartLike[]]>): Map<string, PartLike[]> {
  return new Map(entries.map(([k, v]) => [k, [...v]]))
}

const ALL = typesOf("text", "reasoning", "tool")

function happyPlan(): { plan: RewritePlan; state: Map<string, PartLike[]> } {
  const stretch = stretchOf("s1", "m1", "m2")
  const state = partsMap([
    ["m1", [textPart("p1", "m1", "hola mundo"), reasoningPart("r1", "m1", "pienso")]],
    ["m2", [textPart("p2", "m2", "otro texto"), toolPart("t1", "m2", "bash", "completed", "salida")]],
  ])
  const flat: PartLike[] = [...(state.get("m1") ?? []), ...(state.get("m2") ?? [])]
  const plan = buildRewritePlan(
    stretch,
    flat,
    { summary: "resumen destilado", stubs: { m2: "hizo equis" } },
    ALL,
  )
  return { plan, state }
}

function originalsOf(
  stretch: Stretch,
  state: ReadonlyMap<string, readonly PartLike[]>,
): ReadonlyArray<{ messageID: string; part: PartLike }> {
  return snapshotForTrace(stretch, state).originals
}

describe("stableStringify", () => {
  test("ordena keys recursivamente (objetos anidados + arrays)", () => {
    const a = stableStringify({ z: 1, a: { d: 4, b: 2 }, m: [{ y: 1, x: 2 }] })
    expect(a).toBe('{"a":{"b":2,"d":4},"m":[{"x":2,"y":1}],"z":1}')
  })
  test("primitivas y arrays pasan intactos", () => {
    expect(stableStringify("hola")).toBe('"hola"')
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]")
    expect(stableStringify(undefined)).toBe(undefined as unknown as string)
  })
})

describe("partHash — FNV-1a-64", () => {
  test("determinismo + hex 16 lowercase", () => {
    const p = textPart("p1", "m1", "hola")
    expect(partHash(p)).toBe(partHash(textPart("p1", "m1", "hola")))
    expect(partHash(p)).toMatch(/^[0-9a-f]{16}$/)
  })
  test("independiente del orden de keys", () => {
    const a: PartLike = { id: "p1", sessionID: "s", messageID: "m", type: "text", text: "x" }
    const b: PartLike = { type: "text", text: "x", messageID: "m", sessionID: "s", id: "p1" }
    expect(partHash(a)).toBe(partHash(b))
  })
  test("contenido distinto → hash distinto", () => {
    expect(partHash(textPart("p1", "m1", "hola"))).not.toBe(partHash(textPart("p1", "m1", "chau")))
  })
})

describe("simulatePlan — happy + orden UPDATE→DELETE", () => {
  test("plan del builder real pasa I1–I8 en todos los intermedios", () => {
    const { plan, state } = happyPlan()
    // Sanity: el builder emite UPDATEs antes que DELETEs.
    const firstDelete = plan.ops.findIndex((o) => o.kind === "delete")
    expect(firstDelete).toBeGreaterThan(0)
    const res = simulatePlan(plan, state, { originals: originalsOf(plan.stretch, state) })
    expect(res).toEqual({ ok: true })
  })
  test("orden manual UPDATE-stub→DELETE satisface I1 en intermedios", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const state = partsMap([
      ["m1", [textPart("p1", "m1", "texto uno")]],
      ["m2", [textPart("p2", "m2", "texto dos")]],
    ])
    const stub: PartLike = {
      id: "prt_stub_m2",
      sessionID: "s1",
      messageID: "m2",
      type: "text",
      text: "stub de m2",
      synthetic: true,
      metadata: { stub: true, traceRef: "abc" },
    }
    const plan: RewritePlan = {
      stretch,
      ops: [
        { kind: "update", messageID: "m2", part: stub },
        { kind: "delete", messageID: "m2", partID: "p2" },
      ],
      mass: { beforeChars: 18, afterChars: 9, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res).toEqual({ ok: true })
  })
})

describe("simulatePlan — I1 en intermedios (no solo al final)", () => {
  test("delete del único text sin stub previo → I1 en afterOpIndex 0", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const state = partsMap([
      ["m1", [textPart("p1", "m1", "texto uno")]],
      ["m2", [textPart("p2", "m2", "texto dos")]],
    ])
    const plan: RewritePlan = {
      stretch,
      ops: [{ kind: "delete", messageID: "m2", partID: "p2" }],
      mass: { beforeChars: 18, afterChars: 9, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected I1 violation")
    expect(res.invariant).toBe("I1")
    expect(res.afterOpIndex).toBe(0)
  })
  test("delete segundo deja vacío aunque el primero pasó: afterOpIndex 1", () => {
    const stretch = stretchOf("s1", "m1")
    const state = partsMap([
      ["m1", [textPart("p1", "m1", "uno"), textPart("p2", "m1", "dos"), reasoningPart("r1", "m1", "x")]],
    ])
    const ops: readonly PartOp[] = [
      { kind: "delete", messageID: "m1", partID: "p1" },
      { kind: "delete", messageID: "m1", partID: "p2" },
    ]
    const plan: RewritePlan = {
      stretch,
      ops,
      mass: { beforeChars: 7, afterChars: 0, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected I1 violation")
    expect(res.invariant).toBe("I1")
    expect(res.afterOpIndex).toBe(1)
  })
})

describe("simulatePlan — I4 allowlist sobre tipo fetch-eado", () => {
  test("delete de step-finish (tipo real) → I4", () => {
    const stretch = stretchOf("s1", "m1")
    const state = partsMap([
      ["m1", [textPart("p1", "m1", "texto"), oddPart("sf1", "m1", "step-finish")]],
    ])
    const plan: RewritePlan = {
      stretch,
      ops: [{ kind: "delete", messageID: "m1", partID: "sf1" }],
      mass: { beforeChars: 5, afterChars: 5, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected I4 violation")
    expect(res.invariant).toBe("I4")
    expect(res.afterOpIndex).toBe(0)
  })
  test("update que cambia tipo text→file → I4 (tipo nuevo fuera del allowlist)", () => {
    const stretch = stretchOf("s1", "m1")
    const state = partsMap([["m1", [textPart("p1", "m1", "texto")]]])
    const plan: RewritePlan = {
      stretch,
      ops: [{ kind: "update", messageID: "m1", part: oddPart("p1", "m1", "file") }],
      mass: { beforeChars: 5, afterChars: 0, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected I4 violation")
    expect(res.invariant).toBe("I4")
  })
})

describe("simulatePlan — I5 localidad", () => {
  test("op sobre mensaje fuera del stretch → I5", () => {
    const stretch = stretchOf("s1", "m1")
    const state = partsMap([
      ["m1", [textPart("p1", "m1", "texto")]],
      ["m9", [textPart("p9", "m9", "fuera")]],
    ])
    const plan: RewritePlan = {
      stretch,
      ops: [{ kind: "delete", messageID: "m9", partID: "p9" }],
      mass: { beforeChars: 5, afterChars: 5, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected I5 violation")
    expect(res.invariant).toBe("I5")
    expect(res.afterOpIndex).toBe(0)
  })
})

describe("simulatePlan — I2/I3/I6/I7/I8 finales", () => {
  test("I2: stub creado sin synthetic ni marca → I2", () => {
    const stretch = stretchOf("s1", "m1")
    const state = partsMap([["m1", [textPart("p1", "m1", "texto")]]])
    const plan: RewritePlan = {
      stretch,
      ops: [
        { kind: "update", messageID: "m1", part: textPart("prt_stub_m1", "m1", "stub sin marca") },
      ],
      mass: { beforeChars: 5, afterChars: 14, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected I2 violation")
    expect(res.invariant).toBe("I2")
  })
  test("I3: tool con preview != output → I3", () => {
    const stretch = stretchOf("s1", "m1")
    const t = toolPart("t1", "m1", "bash", "completed", "salida real")
    const state = partsMap([["m1", [textPart("p1", "m1", "texto"), t]]])
    const bad: Toolish = {
      ...t,
      state: { status: "completed", output: "OTRO output" },
      metadata: { preview: "preview distinto" },
    }
    const plan: RewritePlan = {
      stretch,
      ops: [{ kind: "update", messageID: "m1", part: bad }],
      mass: { beforeChars: 16, afterChars: 16, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected I3 violation")
    expect(res.invariant).toBe("I3")
  })
  test("I3: tool intacta con preview stale (no reescrita por el plan) → ok", () => {
    const stretch = stretchOf("s1", "m1")
    const staleTool: Toolish = {
      ...toolPart("t1", "m1", "bash", "completed", "salida completa del server"),
      metadata: { preview: "preview viejo del server" },
    }
    const state = partsMap([["m1", [textPart("p1", "m1", "texto"), staleTool]]])
    const distillate: PartLike = {
      id: "prt_distill_abc",
      sessionID: "s1",
      messageID: "m1",
      type: "text",
      text: "resumen",
      synthetic: true,
      metadata: { distilled: true, traceRef: "abc" },
    }
    const plan: RewritePlan = {
      stretch,
      ops: [
        { kind: "update", messageID: "m1", part: distillate },
        { kind: "delete", messageID: "m1", partID: "p1" },
      ],
      mass: { beforeChars: 5, afterChars: 7, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res).toEqual({ ok: true })
  })
  test("I3: tool reescrita con preview == output → ok", () => {
    const stretch = stretchOf("s1", "m1")
    const t = toolPart("t1", "m1", "bash", "completed", "salida real")
    const state = partsMap([["m1", [textPart("p1", "m1", "texto"), t]]])
    const stubbed: Toolish = {
      ...t,
      state: { status: "completed", output: "[distilled] bash — see distillate" },
      metadata: { preview: "[distilled] bash — see distillate" },
    }
    const plan: RewritePlan = {
      stretch,
      ops: [{ kind: "update", messageID: "m1", part: stubbed }],
      mass: { beforeChars: 16, afterChars: 16, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res).toEqual({ ok: true })
  })
  test("I6: op sobre user message → I6", () => {
    const stretch = stretchOf("s1", "m1", "u1")
    const state = partsMap([
      ["m1", [textPart("p1", "m1", "texto")]],
      ["u1", [textPart("pu", "u1", "pregunta user")]],
    ])
    const plan: RewritePlan = {
      stretch,
      ops: [{ kind: "delete", messageID: "u1", partID: "pu" }],
      mass: { beforeChars: 18, afterChars: 5, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    // Sin userMessageIDs el guard no puede saberlo: pasa I6 (se documenta).
    const blind = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(blind.ok).toBe(false) // cae por I1 (u1 queda vacío), no por I6
    if (blind.ok) throw new Error("expected failure")
    expect(blind.invariant).toBe("I1")
    // Con el set, el guard explícito dispara I6 antes de aplicar.
    const guarded = simulatePlan(plan, state, {
      originals: originalsOf(stretch, state),
      userMessageIDs: new Set(["u1"]),
    })
    expect(guarded.ok).toBe(false)
    if (guarded.ok) throw new Error("expected I6 violation")
    expect(guarded.invariant).toBe("I6")
  })
  test("I7: compaction dentro del stretch → I7", () => {
    const stretch = stretchOf("s1", "m1")
    const state = partsMap([
      ["m1", [textPart("p1", "m1", "texto"), oddPart("c1", "m1", "compaction")]],
    ])
    const plan: RewritePlan = {
      stretch,
      ops: [],
      mass: { beforeChars: 5, afterChars: 5, cacheInvalidationFrom: "m1", estBreakEvenTurns: 1 },
    }
    const res = simulatePlan(plan, state, { originals: originalsOf(stretch, state) })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected I7 violation")
    expect(res.invariant).toBe("I7")
  })
  test("I8: sin snapshot de originals habiendo partes tocadas → I8", () => {
    const { plan, state } = happyPlan()
    const res = simulatePlan(plan, state)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected I8 violation")
    expect(res.invariant).toBe("I8")
  })
  test("I8: snapshot incompleto (falta una parte tocada) → I8", () => {
    const { plan, state } = happyPlan()
    const full = originalsOf(plan.stretch, state)
    const res = simulatePlan(plan, state, { originals: full.slice(1) })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected I8 violation")
    expect(res.invariant).toBe("I8")
  })
})

describe("snapshotForTrace", () => {
  test("originals verbatim + hashes por parte (solo mutables, solo stretch)", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const p1 = textPart("p1", "m1", "texto")
    const r1 = reasoningPart("r1", "m1", "razón")
    const sf = oddPart("sf1", "m1", "step-finish")
    const p2 = textPart("p2", "m2", "otro")
    const outside = textPart("px", "m9", "fuera del stretch")
    const state = partsMap([
      ["m1", [p1, r1, sf]],
      ["m2", [p2]],
      ["m9", [outside]],
    ])
    const snap = snapshotForTrace(stretch, state)
    // Verbatim: igualdad profunda con las partes reales.
    expect(snap.originals).toEqual([
      { messageID: "m1", part: p1 },
      { messageID: "m1", part: r1 },
      { messageID: "m2", part: p2 },
    ])
    // step-finish y m9 quedan afuera (no mutables / fuera del stretch).
    expect(snap.originals.length).toBe(3)
    // Hashes: uno por original, iguales a partHash.
    expect(snap.hashes).toEqual([
      { partID: "p1", hash: partHash(p1) },
      { partID: "r1", hash: partHash(r1) },
      { partID: "p2", hash: partHash(p2) },
    ])
  })
  test("snapshot es copia: mutar el estado después no cambia los originals", () => {
    const stretch = stretchOf("s1", "m1")
    const p1 = textPart("p1", "m1", "texto")
    const state = partsMap([["m1", [p1]]])
    const snap = snapshotForTrace(stretch, state)
    p1.text = "MUTADO"
    expect(snap.originals[0]?.part.text).toBe("texto")
  })
})
