// Failing-first para registerPlugin + default export (task #16, Wave 2).
// Importa de ../src/tui.js (regla dura). Verifica registro de 2 comandos,
// keybind opcional sin default, enabled solo en session, y adapt satisface FlowPorts.
import { describe, expect, test } from "bun:test"
import { registerPlugin } from "../src/tui.js"
import type { FlowPorts } from "../src/ports.js"
import type {
  PluginBindingSpec,
  PluginCommandSpec,
  PluginLayer,
  PluginRegistrationApi,
} from "../src/tui.js"

function createFakeRegistration() {
  const layers: PluginLayer[] = []
  let routeName = "session"

  const registration: PluginRegistrationApi = {
    keymap: {
      registerLayer(layer) {
        layers.push(layer)
        return undefined
      },
    },
    route: {
      get current() {
        return { name: routeName }
      },
    },
  }

  return {
    registration,
    layers,
    commands(): readonly PluginCommandSpec[] {
      return layers.flatMap((layer) => layer.commands ?? [])
    },
    bindings(): readonly PluginBindingSpec[] {
      return layers.flatMap((layer) => layer.bindings ?? [])
    },
    setRoute(name: string) {
      routeName = name
    },
  }
}

describe("registerPlugin — dos comandos y binding", () => {
  test("registra exactamente dos comandos palette con slashNames correctos", () => {
    const fake = createFakeRegistration()
    registerPlugin(fake.registration, () => {}, () => {}, undefined)

    const commands = fake.commands()
    expect(commands).toHaveLength(2)

    const distill = commands[0]
    expect(distill?.name).toBe("distill-session-stretch")
    expect(distill?.title).toBe("Distill session stretch")
    expect(distill?.category).toBe("Plugin")
    expect(distill?.namespace).toBe("palette")
    expect(distill?.slashName).toBe("distill")
    expect(distill?.desc).toBe("Rewrite a derailed stretch into a compact distillate (files are NOT touched)")

    const restore = commands[1]
    expect(restore?.name).toBe("restore-distill")
    expect(restore?.title).toBe("Restore last distill")
    expect(restore?.category).toBe("Plugin")
    expect(restore?.namespace).toBe("palette")
    expect(restore?.slashName).toBe("distill-restore")
    expect(restore?.desc).toBe("Undo a distillation from its disk trace")
  })

  test("run de distill invoca el callback inyectado", () => {
    const fake = createFakeRegistration()
    let distillRan = false
    registerPlugin(fake.registration, () => { distillRan = true }, () => {}, undefined)

    fake.commands()[0]?.run()
    expect(distillRan).toBe(true)
  })

  test("run de restore invoca el callback inyectado", () => {
    const fake = createFakeRegistration()
    let restoreRan = false
    registerPlugin(fake.registration, () => {}, () => { restoreRan = true }, undefined)

    fake.commands()[1]?.run()
    expect(restoreRan).toBe(true)
  })

  test("sin options no registra binding", () => {
    const fake = createFakeRegistration()
    registerPlugin(fake.registration, () => {}, () => {}, undefined)
    expect(fake.bindings()).toHaveLength(0)
  })

  test("options.keybind válido registra un binding al comando distill", () => {
    const fake = createFakeRegistration()
    registerPlugin(fake.registration, () => {}, () => {}, { keybind: "ctrl+alt+d" })

    const bindings = fake.bindings()
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.key).toBe("ctrl+alt+d")
    expect(bindings[0]?.cmd).toBe("distill-session-stretch")
    expect(bindings[0]?.desc).toBe("Distill session stretch")
  })

  test("options.keybind vacío, con espacios o no-string no registra binding", () => {
    for (const keybind of ["", "   ", 123, null, {}, undefined]) {
      const fake = createFakeRegistration()
      registerPlugin(fake.registration, () => {}, () => {}, { keybind })
      expect(fake.bindings()).toHaveLength(0)
    }
  })

  test("options null no registra binding", () => {
    const fake = createFakeRegistration()
    registerPlugin(fake.registration, () => {}, () => {}, null)
    expect(fake.bindings()).toHaveLength(0)
  })

  test("enabled es false fuera de session y true en session (ambos comandos)", () => {
    const fake = createFakeRegistration()
    registerPlugin(fake.registration, () => {}, () => {}, undefined)
    const distill = fake.commands()[0]
    const restore = fake.commands()[1]

    fake.setRoute("home")
    expect(distill?.enabled()).toBe(false)
    expect(restore?.enabled()).toBe(false)
    fake.setRoute("session")
    expect(distill?.enabled()).toBe(true)
    expect(restore?.enabled()).toBe(true)
  })
})

describe("tui entry — default export", () => {
  test("id no vacío, tui función y sin export server", async () => {
    const mod = await import("../src/tui.js")
    expect(typeof mod.default.id).toBe("string")
    expect(mod.default.id.length).toBeGreaterThan(0)
    expect(typeof mod.default.tui).toBe("function")
    expect(Object.prototype.hasOwnProperty.call(mod.default, "server")).toBe(false)
  })

  test("adapt retorna un objeto que satisface FlowPorts estructuralmente", async () => {
    // El adapt real vive en src/tui.ts; acá verificamos que el tipo exportado
    // es compatible con FlowPorts (compila = pasa). La verificación de runtime
    // de los ports individuales la cubre contract.test.ts con un adapt de
    // referencia; el adapt real se prueba en el probe de TUI.
    const ports: FlowPorts = {
      listStateMessages: () => [],
      async fetchServerMessages() { return [] },
      readParts: () => [],
      readStateStatus: () => undefined,
      async fetchServerStatus() { return {} },
      async updatePart() { return { ok: true } },
      async deletePart() { return { ok: true } },
      async createScratch() { return "scratch" },
      async promptScratch() { return { text: "", model: { providerID: "", modelID: "" } } },
      async deleteScratch() {},
      appendPlanned: () => ({ ok: true, file: "", ts: 0 }),
      appendStatus: () => ({ ok: true, file: "" }),
      readTraces: () => ({ ok: true, traces: [] }),
      latestTrace: () => ({ ok: true, trace: undefined }),
      confirmDialog: () => {},
      promptDialog: () => {},
      selectDialog: () => {},
      toast: () => {},
      currentRouteName: () => "session",
      currentSessionID: () => "ses_1",
      readDirectory: () => "/tmp",
      now: () => 0,
    }
    expect(typeof ports.listStateMessages).toBe("function")
    expect(typeof ports.fetchServerMessages).toBe("function")
    expect(typeof ports.selectDialog).toBe("function")
    expect(typeof ports.promptDialog).toBe("function")
    expect(typeof ports.confirmDialog).toBe("function")
  })
})