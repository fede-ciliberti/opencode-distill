import { describe, expect, test } from "bun:test"

describe("artefacto dist/tui.js", () => {
  test("importa y exporta { id, tui } sin export server", async () => {
    const mod = await import("../dist/tui.js")
    expect(typeof mod.default.id).toBe("string")
    expect(mod.default.id.length).toBeGreaterThan(0)
    expect(typeof mod.default.tui).toBe("function")
    expect(Object.prototype.hasOwnProperty.call(mod.default, "server")).toBe(false)
  })
})