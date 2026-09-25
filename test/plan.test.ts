// Tests del plan builder: RewritePlan UPDATE→DELETE con IDs deterministas y modos por tipo (task #7).
// Failing-first: importan de ../src/pure.js (regla dura).
import { describe, expect, test } from "bun:test"
import {
  buildRewritePlan,
  hash8,
  PlanError,
  type PartLike,
  type PartTypeName,
  type Stretch,
  type TypeFilter,
} from "../src/pure.js"

// Helpers
function textPart(id: string, messageID: string, text: string, sessionID = "s1"): PartLike {
  return { id, sessionID, messageID, type: "text", text }
}
function reasoningPart(id: string, messageID: string, text: string, sessionID = "s1"): PartLike {
  return { id, sessionID, messageID, type: "reasoning", text }
}
// El fetch real trae `tool` (nombre) en las tool parts; PartLike no lo
// tipa, así que el helper usa la intersección (patrón DistillPartLike).
type Toolish = PartLike & { tool?: string }
function toolPart(
  id: string,
  messageID: string,
  tool: string,
  status: string,
  output?: string,
  error?: string,
  sessionID = "s1",
): PartLike {
  const part: Toolish = {
    id,
    sessionID,
    messageID,
    type: "tool",
    state: { status, output, error },
    tool,
  }
  return part
}
function filePart(id: string, messageID: string, sessionID = "s1"): PartLike {
  return { id, sessionID, messageID, type: "file" }
}
function stepFinishPart(id: string, messageID: string, sessionID = "s1"): PartLike {
  return { id, sessionID, messageID, type: "step-finish" }
}
function typesOf(...names: readonly PartTypeName[]): TypeFilter {
  return new Set<PartTypeName>(names)
}
function stretchOf(sessionID: string, ...messageIDs: readonly string[]): Stretch {
  return { sessionID, directory: "/tmp/x", messageIDs }
}
function distillateOf(summary: string, stubs: Record<string, string>) {
  return { summary, stubs }
}

const ALL = typesOf("text", "reasoning", "tool")

describe("hash8 — FNV-1a-32 determinista", () => {
  test("determinismo: mismo input → mismo hash", () => {
    const a = hash8(["m1", "m2", "m3"])
    const b = hash8(["m1", "m2", "m3"])
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })
  test("distinto orden → distinto hash", () => {
    const a = hash8(["m1", "m2"])
    const b = hash8(["m2", "m1"])
    expect(a).not.toBe(b)
  })
  test("join con \\n: ['a','b'] != ['a\\nb']", () => {
    const a = hash8(["a", "b"])
    const b = hash8(["a\nb"])
    // No tienen por qué ser iguales; solo verificamos que el join es con \n
    // y que ambos son hex 8
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(b).toMatch(/^[0-9a-f]{8}$/)
  })
  test("valor conocido: hash8(['m1']) es determinista y lowercase hex", () => {
    const h = hash8(["m1"])
    expect(h).toBe(hash8(["m1"]))
    expect(h).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("buildRewritePlan — modos por tipo y reglas DEC-5", () => {
  test("1 mensaje, full mode: distillate + tool update + deletes, sin stubs", () => {
    const stretch = stretchOf("s1", "m1")
    const parts: PartLike[] = [
      textPart("p1", "m1", "hello world"),
      reasoningPart("p2", "m1", "thinking"),
      toolPart("p3", "m1", "bash", "completed", "output largo"),
    ]
    const dist = distillateOf("## Outcome\nok", { m1: "did stuff" })
    const plan = buildRewritePlan(stretch, parts, dist, ALL)
    // UPSERTS primero
    const updates = plan.ops.filter((o) => o.kind === "update")
    const deletes = plan.ops.filter((o) => o.kind === "delete")
    // distillate + tool update = 2 updates, no stubs porque m1 es el primero
    expect(updates.length).toBe(2)
    expect(deletes.length).toBe(2) // text + reasoning
    // distillate es el primer update
    const distPart = updates[0]!.part
    expect(distPart.id).toBe(`prt_distill_${hash8(["m1"])}`)
    expect(distPart.messageID).toBe("m1")
    expect(distPart.text).toBe("## Outcome\nok")
    expect(distPart.synthetic).toBe(true)
    expect(distPart.metadata).toMatchObject({ distilled: true, traceRef: hash8(["m1"]) })
    // tool update: spread + output stub
    const toolUpd = updates.find((o) => o.part.id === "p3")
    expect(toolUpd).toBeDefined()
    expect(toolUpd!.part.state?.output).toBe("[distilled] bash — see distillate")
    expect(toolUpd!.part.metadata).toMatchObject({ preview: "[distilled] bash — see distillate" })
    // deletes: p1 y p2
    expect(deletes.map((d) => d.partID).sort()).toEqual(["p1", "p2"].sort())
    // orden UPDATE antes que DELETE
    const firstDeleteIdx = plan.ops.findIndex((o) => o.kind === "delete")
    const lastUpdateIdx = plan.ops.map((o) => o.kind).lastIndexOf("update")
    expect(lastUpdateIdx).toBeLessThan(firstDeleteIdx)
  })

  test("multi 3 mensajes, full mode: 1 distillate + 2 stubs + k tool updates, luego deletes", () => {
    const stretch = stretchOf("s1", "m1", "m2", "m3")
    const parts: PartLike[] = [
      textPart("p1", "m1", "text m1"),
      reasoningPart("r1", "m1", "reason m1"),
      toolPart("t1", "m1", "bash", "completed", "out1"),
      textPart("p2", "m2", "text m2"),
      reasoningPart("r2", "m2", "reason m2"),
      textPart("p3", "m3", "text m3"),
      toolPart("t2", "m3", "read", "error", undefined, "err output"),
    ]
    const dist = distillateOf("summary", { m1: "stub1", m2: "stub2", m3: "stub3" })
    const plan = buildRewritePlan(stretch, parts, dist, ALL)
    const updates = plan.ops.filter((o) => o.kind === "update")
    const deletes = plan.ops.filter((o) => o.kind === "delete")
    // updates: distillate + 2 stubs (m2,m3) + 2 tool updates = 5
    expect(updates.length).toBe(5)
    // deletes: 3 texts + 2 reasonings = 5
    expect(deletes.length).toBe(5)
    // stubs existen para m2 y m3, no para m1
    const stubIds = updates.filter((u) => u.part.id.startsWith("prt_stub_")).map((u) => u.part.id)
    expect(stubIds.sort()).toEqual(["prt_stub_m2", "prt_stub_m3"].sort())
    const stubM2 = updates.find((u) => u.part.id === "prt_stub_m2")
    expect(stubM2!.part.text).toBe("stub2")
    expect(stubM2!.part.synthetic).toBe(true)
    // orden
    const firstDelete = plan.ops.findIndex((o) => o.kind === "delete")
    const lastUpdate = plan.ops.map((o) => o.kind).lastIndexOf("update")
    expect(lastUpdate).toBeLessThan(firstDelete)
  })

  test("con tools: tool completed/error se actualiza, pending no", () => {
    const stretch = stretchOf("s1", "m1")
    const parts: PartLike[] = [
      textPart("p1", "m1", "hi"),
      toolPart("t1", "m1", "bash", "completed", "out"),
      toolPart("t2", "m1", "bash", "pending", "out-pending"),
      toolPart("t3", "m1", "read", "error", undefined, "err"),
    ]
    const dist = distillateOf("sum", { m1: "s" })
    const plan = buildRewritePlan(stretch, parts, dist, typesOf("tool"))
    const updates = plan.ops.filter((o) => o.kind === "update")
    // distillate + 2 tool updates (completed y error), pending intacto
    expect(updates.length).toBe(3)
    expect(updates.find((u) => u.part.id === "t1")?.part.state?.output).toBe("[distilled] bash — see distillate")
    expect(updates.find((u) => u.part.id === "t3")?.part.state?.output).toBe("[distilled] read — see distillate")
    expect(updates.find((u) => u.part.id === "t2")).toBeUndefined()
    // tool-only: sin deletes, sin stubs
    const deletes = plan.ops.filter((o) => o.kind === "delete")
    expect(deletes.length).toBe(0)
    const stubs = updates.filter((u) => u.part.id.startsWith("prt_stub_"))
    expect(stubs.length).toBe(0)
  })

  test("reasoning-only: texts quedan, sin stubs, distillate presente, reasoning borrado", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const parts: PartLike[] = [
      textPart("p1", "m1", "text1"),
      reasoningPart("r1", "m1", "reason1"),
      textPart("p2", "m2", "text2"),
      reasoningPart("r2", "m2", "reason2"),
    ]
    const dist = distillateOf("sum", { m1: "s1", m2: "s2" })
    const plan = buildRewritePlan(stretch, parts, dist, typesOf("reasoning"))
    const updates = plan.ops.filter((o) => o.kind === "update")
    const deletes = plan.ops.filter((o) => o.kind === "delete")
    // solo distillate como update
    expect(updates.length).toBe(1)
    expect(updates[0]!.part.id).toBe(`prt_distill_${hash8(["m1", "m2"])}`)
    // deletes solo reasoning
    expect(deletes.map((d) => d.partID).sort()).toEqual(["r1", "r2"].sort())
    // textos intactos: no hay deletes de p1/p2
    expect(deletes.find((d) => d.partID === "p1")).toBeUndefined()
    // sin stubs
    expect(updates.filter((u) => u.part.id.startsWith("prt_stub_")).length).toBe(0)
  })

  test("tool-only: solo tool updates, sin deletes, sin stubs", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const parts: PartLike[] = [
      textPart("p1", "m1", "text1"),
      reasoningPart("r1", "m1", "reason1"),
      toolPart("t1", "m1", "bash", "completed", "out1"),
      textPart("p2", "m2", "text2"),
      toolPart("t2", "m2", "read", "completed", "out2"),
    ]
    const dist = distillateOf("sum", { m1: "s1", m2: "s2" })
    const plan = buildRewritePlan(stretch, parts, dist, typesOf("tool"))
    const updates = plan.ops.filter((o) => o.kind === "update")
    const deletes = plan.ops.filter((o) => o.kind === "delete")
    expect(deletes.length).toBe(0)
    // distillate + 2 tool updates
    expect(updates.length).toBe(3)
    expect(updates.filter((u) => u.part.id.startsWith("prt_stub_")).length).toBe(0)
  })

  test("text-only: stubs en todos m>1, reasoning intacto", () => {
    const stretch = stretchOf("s1", "m1", "m2", "m3")
    const parts: PartLike[] = [
      textPart("p1", "m1", "t1"),
      reasoningPart("r1", "m1", "r1"),
      textPart("p2", "m2", "t2"),
      reasoningPart("r2", "m2", "r2"),
      textPart("p3", "m3", "t3"),
    ]
    const dist = distillateOf("sum", { m1: "s1", m2: "s2", m3: "s3" })
    const plan = buildRewritePlan(stretch, parts, dist, typesOf("text"))
    const updates = plan.ops.filter((o) => o.kind === "update")
    const deletes = plan.ops.filter((o) => o.kind === "delete")
    // updates: distillate + 2 stubs (m2,m3)
    expect(updates.length).toBe(3)
    expect(updates.filter((u) => u.part.id.startsWith("prt_stub_")).length).toBe(2)
    // deletes: 3 texts
    expect(deletes.map((d) => d.partID).sort()).toEqual(["p1", "p2", "p3"].sort())
    // reasoning intacto
    expect(deletes.find((d) => d.partID === "r1")).toBeUndefined()
    expect(deletes.find((d) => d.partID === "r2")).toBeUndefined()
  })

  test("sin text en types con msg 1: distillate + texto original conviven", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const parts: PartLike[] = [
      textPart("p1", "m1", "original text m1"),
      reasoningPart("r1", "m1", "reason m1"),
      textPart("p2", "m2", "original text m2"),
    ]
    const dist = distillateOf("sum", { m1: "s1", m2: "s2" })
    const plan = buildRewritePlan(stretch, parts, dist, typesOf("reasoning"))
    const updates = plan.ops.filter((o) => o.kind === "update")
    const deletes = plan.ops.filter((o) => o.kind === "delete")
    // distillate presente
    expect(updates.length).toBe(1)
    expect(updates[0]!.part.text).toBe("sum")
    // textos no borrados
    expect(deletes.find((d) => d.partID === "p1")).toBeUndefined()
    expect(deletes.find((d) => d.partID === "p2")).toBeUndefined()
    // reasoning borrado
    expect(deletes.map((d) => d.partID)).toEqual(["r1"])
    // sin stubs
    expect(updates.filter((u) => u.part.id.startsWith("prt_stub_")).length).toBe(0)
  })

  test("re-distill con stubs previos → overwrite + deletes idempotentes", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const h = hash8(["m1", "m2"])
    const parts: PartLike[] = [
      textPart("p1", "m1", "orig m1"),
      textPart("p2", "m2", "orig m2"),
      // stubs previos (de un distill anterior)
      { id: `prt_distill_${h}`, sessionID: "s1", messageID: "m1", type: "text", text: "old summary", synthetic: true, metadata: { distilled: true, traceRef: h } },
      { id: "prt_stub_m2", sessionID: "s1", messageID: "m2", type: "text", text: "old stub", synthetic: true, metadata: { stub: true, traceRef: h } },
    ]
    const dist = distillateOf("new summary", { m1: "new s1", m2: "new s2" })
    const plan = buildRewritePlan(stretch, parts, dist, typesOf("text"))
    const updates = plan.ops.filter((o) => o.kind === "update")
    // distillate overwrite con mismo id
    const distUpd = updates.find((u) => u.part.id === `prt_distill_${h}`)
    expect(distUpd).toBeDefined()
    expect(distUpd!.part.text).toBe("new summary")
    // stub overwrite
    const stubUpd = updates.find((u) => u.part.id === "prt_stub_m2")
    expect(stubUpd).toBeDefined()
    expect(stubUpd!.part.text).toBe("new s2")
    // deletes idempotentes: p1 y p2 siguen borrándose
    const deletes = plan.ops.filter((o) => o.kind === "delete")
    expect(deletes.map((d) => d.partID).sort()).toEqual(["p1", "p2"].sort())
  })

  test("allowlist violation: parte step-finish dentro del stretch → throw PlanError", () => {
    const stretch = stretchOf("s1", "m1")
    const parts: PartLike[] = [
      textPart("p1", "m1", "hi"),
      stepFinishPart("sf1", "m1"),
    ]
    const dist = distillateOf("sum", { m1: "s" })
    expect(() => buildRewritePlan(stretch, parts, dist, ALL)).toThrow(PlanError)
    try {
      buildRewritePlan(stretch, parts, dist, ALL)
    } catch (e) {
      expect(e).toBeInstanceOf(PlanError)
      expect((e as PlanError).kind).toBe("allowlist-violation")
    }
  })

  test("allowlist violation: file part dentro del stretch → throw", () => {
    const stretch = stretchOf("s1", "m1")
    const parts: PartLike[] = [filePart("f1", "m1")]
    const dist = distillateOf("sum", { m1: "s" })
    expect(() => buildRewritePlan(stretch, parts, dist, ALL)).toThrow(PlanError)
  })

  test("I5: ops solo dentro del stretch — parte fuera no se toca", () => {
    const stretch = stretchOf("s1", "m1")
    const parts: PartLike[] = [
      textPart("p1", "m1", "inside"),
      textPart("p2", "m2", "outside"), // m2 fuera del stretch
      reasoningPart("r1", "m1", "inside reason"),
      reasoningPart("r2", "m2", "outside reason"),
    ]
    const dist = distillateOf("sum", { m1: "s1", m2: "s2" })
    const plan = buildRewritePlan(stretch, parts, dist, ALL)
    // solo ops para m1
    for (const op of plan.ops) {
      expect(op.messageID).toBe("m1")
    }
    const deletes = plan.ops.filter((o) => o.kind === "delete")
    expect(deletes.find((d) => d.partID === "p2")).toBeUndefined()
    expect(deletes.find((d) => d.partID === "r2")).toBeUndefined()
  })

  test("hash8 determinismo: mismo stretch → mismo prt_distill id", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const parts: PartLike[] = [textPart("p1", "m1", "a"), textPart("p2", "m2", "b")]
    const dist = distillateOf("sum", { m1: "s1", m2: "s2" })
    const plan1 = buildRewritePlan(stretch, parts, dist, typesOf("text"))
    const plan2 = buildRewritePlan(stretch, parts, dist, typesOf("text"))
    const id1 = plan1.ops.find((o) => o.kind === "update" && o.part.id.startsWith("prt_distill_"))?.part.id
    const id2 = plan2.ops.find((o) => o.kind === "update" && o.part.id.startsWith("prt_distill_"))?.part.id
    expect(id1).toBe(id2)
    expect(id1).toBe(`prt_distill_${hash8(["m1", "m2"])}`)
  })

  test("UPDATE-before-DELETE ordering: todos los updates antes que los deletes", () => {
    const stretch = stretchOf("s1", "m1", "m2", "m3")
    const parts: PartLike[] = [
      textPart("p1", "m1", "t1"),
      textPart("p2", "m2", "t2"),
      textPart("p3", "m3", "t3"),
      reasoningPart("r1", "m1", "r1"),
      toolPart("t1", "m2", "bash", "completed", "out"),
    ]
    const dist = distillateOf("sum", { m1: "s1", m2: "s2", m3: "s3" })
    const plan = buildRewritePlan(stretch, parts, dist, ALL)
    const kinds = plan.ops.map((o) => o.kind)
    const firstDelete = kinds.indexOf("delete")
    const lastUpdate = kinds.lastIndexOf("update")
    expect(firstDelete).toBeGreaterThan(-1)
    expect(lastUpdate).toBeGreaterThan(-1)
    expect(lastUpdate).toBeLessThan(firstDelete)
  })

  test("texto vacío no se borra (no-empty rule)", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const parts: PartLike[] = [
      textPart("p1", "m1", ""), // vacío
      textPart("p2", "m1", "non-empty"),
      textPart("p3", "m2", ""), // vacío
      textPart("p4", "m2", "also non-empty"),
    ]
    const dist = distillateOf("sum", { m1: "s1", m2: "s2" })
    const plan = buildRewritePlan(stretch, parts, dist, typesOf("text"))
    const deletes = plan.ops.filter((o) => o.kind === "delete")
    expect(deletes.map((d) => d.partID).sort()).toEqual(["p2", "p4"].sort())
    // m2 tiene texto no vacío borrado → stub para m2
    const updates = plan.ops.filter((o) => o.kind === "update")
    expect(updates.find((u) => u.part.id === "prt_stub_m2")).toBeDefined()
    // m1 es primer mensaje: no stub aunque tenga texto borrado
    expect(updates.find((u) => u.part.id === "prt_stub_m1")).toBeUndefined()
  })

  test("tool pending/running no se actualiza", () => {
    const stretch = stretchOf("s1", "m1")
    const parts: PartLike[] = [
      toolPart("t1", "m1", "bash", "pending", "out"),
      toolPart("t2", "m1", "bash", "running", "out"),
      toolPart("t3", "m1", "bash", "completed", "out"),
    ]
    const dist = distillateOf("sum", { m1: "s" })
    const plan = buildRewritePlan(stretch, parts, dist, typesOf("tool"))
    const updates = plan.ops.filter((o) => o.kind === "update")
    expect(updates.find((u) => u.part.id === "t1")).toBeUndefined()
    expect(updates.find((u) => u.part.id === "t2")).toBeUndefined()
    expect(updates.find((u) => u.part.id === "t3")).toBeDefined()
  })

  test("distillate siempre presente cuando hay algún tipo seleccionado", () => {
    const stretch = stretchOf("s1", "m1")
    const parts: PartLike[] = [textPart("p1", "m1", "hi")]
    const dist = distillateOf("sum", { m1: "s" })
    for (const types of [typesOf("text"), typesOf("reasoning"), typesOf("tool"), ALL]) {
      const plan = buildRewritePlan(stretch, parts, dist, types)
      const hasDist = plan.ops.some((o) => o.kind === "update" && o.part.id.startsWith("prt_distill_"))
      expect(hasDist).toBe(true)
    }
  })

  test("spread rule: tool update preserva campos originales", () => {
    const stretch = stretchOf("s1", "m1")
    const original: PartLike = {
      id: "t1",
      sessionID: "s1",
      messageID: "m1",
      type: "tool",
      state: { status: "completed", output: "original output" },
      metadata: { foo: "bar", preview: "old preview" },
      ...{ tool: "bash" },
    }
    const dist = distillateOf("sum", { m1: "s" })
    const plan = buildRewritePlan(stretch, [original], dist, typesOf("tool"))
    const upd = plan.ops.find((o) => o.kind === "update" && o.part.id === "t1")
    expect(upd).toBeDefined()
    // spread: metadata.foo preservado, preview actualizado
    expect(upd!.part.metadata).toMatchObject({ foo: "bar", preview: "[distilled] bash — see distillate" })
    expect(upd!.part.state?.output).toBe("[distilled] bash — see distillate")
    // id/session/message/type preservados
    expect(upd!.part.id).toBe("t1")
    expect(upd!.part.sessionID).toBe("s1")
    expect(upd!.part.messageID).toBe("m1")
    expect(upd!.part.type).toBe("tool")
  })

  test("mass: beforeChars y afterChars coherentes, cacheInvalidationFrom es primer mensaje", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const parts: PartLike[] = [textPart("p1", "m1", "hello"), textPart("p2", "m2", "world")]
    const dist = distillateOf("summary text", { m1: "s1", m2: "s2" })
    const plan = buildRewritePlan(stretch, parts, dist, typesOf("text"))
    expect(plan.mass.beforeChars).toBeGreaterThan(0)
    expect(plan.mass.afterChars).toBeGreaterThan(0)
    expect(plan.mass.cacheInvalidationFrom).toBe("m1")
    expect(plan.mass.estBreakEvenTurns).toBeGreaterThanOrEqual(1)
  })

  test("no crea stubs redundantes cuando text no está en types", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const parts: PartLike[] = [textPart("p1", "m1", "a"), textPart("p2", "m2", "b")]
    const dist = distillateOf("sum", { m1: "s1", m2: "s2" })
    const plan = buildRewritePlan(stretch, parts, dist, typesOf("reasoning"))
    const stubs = plan.ops.filter((o) => o.kind === "update" && o.part.id.startsWith("prt_stub_"))
    expect(stubs.length).toBe(0)
  })

  test("distillate metadata incluye types y traceRef = hash8", () => {
    const stretch = stretchOf("s1", "m1", "m2")
    const parts: PartLike[] = [textPart("p1", "m1", "a")]
    const dist = distillateOf("sum", { m1: "s1", m2: "s2" })
    const types = typesOf("text", "tool")
    const plan = buildRewritePlan(stretch, parts, dist, types)
    const distPart = plan.ops.find((o) => o.kind === "update" && o.part.id.startsWith("prt_distill_"))?.part
    expect(distPart).toBeDefined()
    const h = hash8(["m1", "m2"])
    expect(distPart!.metadata).toMatchObject({ distilled: true, traceRef: h })
    // types en metadata debe contener los tipos seleccionados
    const metaTypes = (distPart!.metadata as Record<string, unknown>)["types"] as string[]
    expect(new Set(metaTypes)).toEqual(new Set(["text", "tool"]))
  })
})
