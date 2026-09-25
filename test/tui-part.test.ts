// Test de toSdkPart: preservación de campos del state original (task #16 fix).
// Importa de ../src/tui.js (regla dura).
import { describe, expect, test } from "bun:test"
import { toSdkPart } from "../src/tui.js"
import type { PartLike } from "../src/pure.js"

describe("toSdkPart — preservación de campos del state original", () => {
  test("tool completed: preserva input/title/time/metadata y sobreescribe output", () => {
    const part: PartLike = {
      id: "prt_tool_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      text: undefined,
      state: {
        status: "completed",
        input: { path: "a.txt" },
        output: "old output",
        title: "read a",
        time: { start: 1, end: 2 },
        metadata: { preview: "old" },
      },
      metadata: { distilled: true },
    }
    // Simular el spread del flow: {...original, state: {...original.state, output: new}}
    const flowPart: PartLike = {
      ...part,
      state: { ...part.state!, status: "completed", output: "[distilled] read — see distillate" },
      metadata: { ...part.metadata, preview: "[distilled] read — see distillate" },
    }

    const sdk = toSdkPart(flowPart) as { type: string; state: Record<string, unknown> }
    expect(sdk.type).toBe("tool")
    expect(sdk.state.status).toBe("completed")
    expect(sdk.state.output).toBe("[distilled] read — see distillate")
    expect(sdk.state.input).toEqual({ path: "a.txt" })
    expect(sdk.state.title).toBe("read a")
    expect(sdk.state.time).toEqual({ start: 1, end: 2 })
    expect(sdk.state.metadata).toEqual({ preview: "old" })
  })

  test("tool error: preserva input/time/metadata y sobreescribe error", () => {
    const part: PartLike = {
      id: "prt_tool_2",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      state: {
        status: "error",
        input: { cmd: "ls" },
        error: "old error",
        metadata: { preview: "err" },
        time: { start: 3, end: 4 },
      },
    }

    const sdk = toSdkPart(part) as { type: string; state: Record<string, unknown> }
    expect(sdk.type).toBe("tool")
    expect(sdk.state.status).toBe("error")
    expect(sdk.state.error).toBe("old error")
    expect(sdk.state.input).toEqual({ cmd: "ls" })
    expect(sdk.state.time).toEqual({ start: 3, end: 4 })
    expect(sdk.state.metadata).toEqual({ preview: "err" })
  })

  test("tool sin state original: defaults seguros", () => {
    const part: PartLike = {
      id: "prt_tool_3",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      state: { status: "completed", output: "new" },
    }

    const sdk = toSdkPart(part) as { type: string; state: Record<string, unknown> }
    expect(sdk.state.input).toEqual({})
    expect(sdk.state.title).toBe("")
    expect(sdk.state.time).toEqual({ start: 0, end: 0 })
  })

  test("text: construye TextPart con synthetic y metadata", () => {
    const part: PartLike = {
      id: "prt_distill_abc",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "distilled summary",
      synthetic: true,
      metadata: { distilled: true, traceRef: "abc" },
    }

    const sdk = toSdkPart(part) as { type: string; text: string; synthetic?: boolean }
    expect(sdk.type).toBe("text")
    expect(sdk.text).toBe("distilled summary")
    expect(sdk.synthetic).toBe(true)
  })
})