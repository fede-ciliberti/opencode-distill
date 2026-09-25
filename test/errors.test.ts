// Tests del mapeo de errores del UPDATE (matriz task #14a, espejo de mapDeleteError).
import { describe, expect, test } from "bun:test"
import { mapUpdateError } from "../src/pure.js"

function notFoundBody(): unknown {
  return { name: "NotFoundError", data: { message: "session not found" } }
}

function busyBody(): unknown {
  return { _tag: "SessionBusyError", sessionID: "s1", message: "busy" }
}

describe("mapUpdateError", () => {
  test("409 → busy (defensive, task #5: no 409 real)", () => {
    const mapped = mapUpdateError(busyBody(), 409)
    expect(mapped.kind).toBe("busy")
    expect(mapped.message).toBe("Session was busy — nothing written")
    expect(mapped.status).toBe(409)
  })

  test("404 con forma NotFoundError → session-not-found", () => {
    const mapped = mapUpdateError(notFoundBody(), 404)
    expect(mapped.kind).toBe("session-not-found")
    expect(mapped.message).toBe("Session not found — it may have been deleted")
  })

  test("404 genérico → unsupported-version", () => {
    const mapped = mapUpdateError({ some: "other" }, 404)
    expect(mapped.kind).toBe("unsupported-version")
    expect(mapped.message).toBe("This opencode version doesn't support part writes")
  })

  test("404 con string no-JSON → unsupported-version", () => {
    const mapped = mapUpdateError("not found", 404)
    expect(mapped.kind).toBe("unsupported-version")
  })

  test("400 → request-failed con status", () => {
    const mapped = mapUpdateError({ name: "x" }, 400)
    expect(mapped.kind).toBe("request-failed")
    expect(mapped.message).toBe("Update failed (400)")
  })

  test("500 → request-failed con status", () => {
    const mapped = mapUpdateError({}, 500)
    expect(mapped.kind).toBe("request-failed")
    expect(mapped.message).toBe("Update failed (500)")
  })

  test("sin status ni forma → network", () => {
    const mapped = mapUpdateError({})
    expect(mapped.kind).toBe("network")
    expect(mapped.message).toBe("Could not reach opencode server")
  })

  test("throw del interceptor text/html → version-mismatch", () => {
    const thrown = new Error(
      "Request is not supported by this version of OpenCode Server (Server responded with text/html)",
    )
    const mapped = mapUpdateError(thrown)
    expect(mapped.kind).toBe("version-mismatch")
    expect(mapped.message).toBe("This opencode version doesn't support part writes")
  })

  test("throw con not supported by this version → version-mismatch", () => {
    const thrown = new Error("not supported by this version")
    const mapped = mapUpdateError(thrown)
    expect(mapped.kind).toBe("version-mismatch")
  })

  test("throw de red (fetch) → network", () => {
    const mapped = mapUpdateError(new TypeError("fetch failed"))
    expect(mapped.kind).toBe("network")
    expect(mapped.message).toBe("Could not reach opencode server")
  })

  test("body text/html en string → version-mismatch", () => {
    const mapped = mapUpdateError("<html>nope</html>", 200)
    expect(mapped.kind).toBe("version-mismatch")
  })

  test("string con text/html → version-mismatch", () => {
    const mapped = mapUpdateError("Server responded with text/html", 200)
    expect(mapped.kind).toBe("version-mismatch")
  })

  test("NotFoundError sin status explícito igual matchea sesión", () => {
    const mapped = mapUpdateError(notFoundBody())
    expect(mapped.kind).toBe("session-not-found")
  })
})
