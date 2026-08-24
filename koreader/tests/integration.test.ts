/**
 * Drives the plugin's real modules end to end with KOReader stubbed out.
 *
 * The unit specs cover the pure arithmetic; this covers the wiring between the
 * modules, which is where a nil method call or a swapped argument hides. It
 * loads `marginalia_ask`, `marginalia_memory` and `marginalia_store` as written
 * — nothing reimplemented — against a fake reader whose sidecar, annotations and
 * relay are ordinary Lua tables the assertions can read back.
 *
 * What it cannot do is prove a KOReader API exists; the stubs define whatever
 * the plugin asks for. Those names are checked against the device separately.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error fengari ships no types
import { lauxlib, lua, lualib, to_luastring } from 'fengari'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..', 'marginalia.koplugin')

function runLua(script: string): string {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)

  const check = (status: number, what: string) => {
    if (status !== lua.LUA_OK) throw new Error(`${what}: ${lua.lua_tojsstring(L, -1)}`)
  }

  const bootstrap = readFileSync(join(here, 'fake_koreader.lua'))
  check(lauxlib.luaL_loadbuffer(L, bootstrap, null, to_luastring('@fake_koreader')), 'stubs')
  check(lua.lua_pcall(L, 0, 0, 0), 'stubs')

  // The plugin's own modules, loaded from source in dependency order.
  for (const name of [
    'marginalia_prompt', 'marginalia_digest', 'marginalia_payload',
    'marginalia_util', 'marginalia_store', 'marginalia_view',
    'marginalia_tls', 'marginalia_relay', 'marginalia_memory', 'marginalia_ask',
  ]) {
    const source = readFileSync(join(pluginDir, `${name}.lua`))
    check(lauxlib.luaL_loadbuffer(L, source, null, to_luastring(`@${name}.lua`)), `load ${name}`)
    check(lua.lua_pcall(L, 0, 1, 0), `run ${name}`)
    lua.lua_getglobal(L, to_luastring('package'))
    lua.lua_getfield(L, -1, to_luastring('loaded'))
    lua.lua_pushvalue(L, -3)
    lua.lua_setfield(L, -2, to_luastring(name))
    lua.lua_pop(L, 3)
  }

  // The relay is replaced only once its module is loaded, since the fake
  // overwrites a function on the real one rather than standing in for it.
  check(lauxlib.luaL_loadbuffer(L, to_luastring('INSTALL_FAKE_RELAY()'), null, to_luastring('@relay')), 'relay')
  check(lua.lua_pcall(L, 0, 0, 0), 'relay')

  check(lauxlib.luaL_loadbuffer(L, to_luastring(script), null, to_luastring('@scenario')), 'scenario')
  check(lua.lua_pcall(L, 0, 1, 0), 'scenario')
  return lua.lua_tojsstring(L, -1)
}

describe('the plugin driven end to end', () => {
  it('asks, stores the exchange, and shows it back', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local Store = require("marginalia_store")
      local View = require("marginalia_view")

      local ui = FakeUI()
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "test", cafile = "/ca" }

      RELAY_REPLIES = { "Because the prow goes first." }
      ui.highlight.selected_text = FakeSelection("Father Mapple rose", "/xp/1.0", "/xp/1.20")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("Why a ship's prow?")

      local data = Store.read(ui.doc_settings)
      local thread = data.threads[1]

      return table.concat({
        "annotations=" .. #ui.annotation.annotations,
        "annotation_text=" .. ui.annotation.annotations[1].text,
        "threads=" .. #data.threads,
        "turns=" .. #thread.messages,
        "first_role=" .. thread.messages[1].role,
        "second_role=" .. thread.messages[2].role,
        "answer=" .. thread.messages[2].content,
        "flushed=" .. tostring(ui.doc_settings.flushes > 0),
        "transcript_has_q=" .. tostring(View.transcript(thread):find("Q: Why", 1, true) ~= nil),
      }, "\\n")
    `)

    expect(report).toContain('annotations=1')
    expect(report).toContain('annotation_text=Father Mapple rose')
    expect(report).toContain('threads=1')
    expect(report).toContain('turns=2')
    expect(report).toContain('first_role=user')
    expect(report).toContain('second_role=assistant')
    expect(report).toContain('answer=Because the prow goes first.')
    expect(report).toContain('flushed=true')
    expect(report).toContain('transcript_has_q=true')
  })

  it('reopens an existing conversation instead of asking again', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local ui = FakeUI()
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "test", cafile = "/ca" }

      RELAY_REPLIES = { "First answer." }
      ui.highlight.selected_text = FakeSelection("Father Mapple rose", "/xp/1.0", "/xp/1.20")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("Why a ship's prow?")

      -- The same passage again, arriving as a saved highlight: KOReader hands a
      -- copy of the annotation and its index.
      SHOWN = {}
      ui.highlight.selected_text = FakeSelection("Father Mapple rose", "/xp/COPY", "/xp/COPY2")
      ask:from_selection(ui.highlight, 1)

      return table.concat({
        "dialogs=" .. #INPUT_DIALOGS,
        "viewers=" .. #SHOWN,
        "viewer_shows_answer=" .. tostring((SHOWN[1] or ""):find("First answer.", 1, true) ~= nil),
      }, "\\n")
    `)

    // The second entry must open the conversation, not a question box: one
    // dialog was shown in total, and a viewer carrying the earlier answer.
    expect(report).toContain('dialogs=1')
    expect(report).toContain('viewers=1')
    expect(report).toContain('viewer_shows_answer=true')
  })

  it('folds a conversation into the notes and asks with them', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local Memory = require("marginalia_memory")
      local Store = require("marginalia_store")

      local ui = FakeUI()
      local settings = FakeSettings()
      local memory = Memory:new{ ui = ui, settings = settings,
                                 plugin_version = "test", cafile = "/ca" }
      local ask = Ask:new{ ui = ui, settings = settings, memory = memory,
                           plugin_version = "test", cafile = "/ca" }

      RELAY_REPLIES = { "Answer one.", "Answer two.", "NOTES: prow imagery.", "Answer three." }

      ui.highlight.selected_text = FakeSelection("Father Mapple rose", "/xp/1.0", "/xp/1.20")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("Question one?")

      -- A follow-up takes the thread to four turns, which is the threshold.
      local thread = Store.read(ui.doc_settings).threads[1]
      ask:prompt_for_question({ text = "Father Mapple rose" }, thread, 1)
      ANSWER_QUESTION("Question two?")

      local before = Store.read(ui.doc_settings)
      local due = Memory.is_due(before.threads[1])

      -- The next question in this thread folds first, then asks.
      thread = before.threads[1]
      ask:prompt_for_question({ text = "Father Mapple rose" }, thread, 1)
      ANSWER_QUESTION("Question three?")

      local after = Store.read(ui.doc_settings)
      local asked_with_notes = false
      for _, request in ipairs(RELAY_REQUESTS) do
        if request:find("What you and this reader have discussed", 1, true) then
          asked_with_notes = true
        end
      end

      return table.concat({
        "due_before=" .. tostring(due),
        "requests=" .. #RELAY_REQUESTS,
        "summary=" .. tostring(after.memory and after.memory.summary),
        "counter=" .. tostring(after.threads[1].summarized_count),
        "turns=" .. #after.threads[1].messages,
        "asked_with_notes=" .. tostring(asked_with_notes),
      }, "\\n")
    `)

    expect(report).toContain('due_before=true')
    // Three questions and one summariser call.
    expect(report).toContain('requests=4')
    expect(report).toContain('summary=NOTES: prow imagery.')
    // The counter advanced to the four turns present when the fold was asked
    // for, and the third exchange took the thread to six.
    expect(report).toContain('counter=4')
    expect(report).toContain('turns=6')
    expect(report).toContain('asked_with_notes=true')
  })

  it('keeps the digest through the write that follows it', () => {
    // The regression this guards: Ask:run reads the whole sidecar blob and
    // writes it back, so a fold that wrote independently used to be undone by
    // that write, taking the thread's counter with it.
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local Memory = require("marginalia_memory")
      local Store = require("marginalia_store")

      local ui = FakeUI()
      local settings = FakeSettings()
      local memory = Memory:new{ ui = ui, settings = settings, plugin_version = "t", cafile = "/ca" }
      local ask = Ask:new{ ui = ui, settings = settings, memory = memory,
                           plugin_version = "t", cafile = "/ca" }

      RELAY_REPLIES = { "A1.", "A2.", "DIGEST.", "A3." }
      ui.highlight.selected_text = FakeSelection("A passage", "/xp/1.0", "/xp/1.9")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("Q1?")
      local thread = Store.read(ui.doc_settings).threads[1]
      ask:prompt_for_question({ text = "A passage" }, thread, 1)
      ANSWER_QUESTION("Q2?")

      -- Deliberately hand the *stale* pre-fold thread object to the follow-up,
      -- which is what the viewer does.
      local stale = Store.read(ui.doc_settings).threads[1]
      ask:prompt_for_question({ text = "A passage" }, stale, 1)
      ANSWER_QUESTION("Q3?")

      local after = Store.read(ui.doc_settings)
      return table.concat({
        "summary=" .. tostring(after.memory and after.memory.summary),
        "counter=" .. tostring(after.threads[1].summarized_count),
      }, "\\n")
    `)

    expect(report).toContain('summary=DIGEST.')
    expect(report).toContain('counter=4')
  })

  it('sweeps a one-exchange conversation the automatic path cannot reach', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local Memory = require("marginalia_memory")
      local Store = require("marginalia_store")

      local ui = FakeUI()
      local settings = FakeSettings()
      local memory = Memory:new{ ui = ui, settings = settings, plugin_version = "t", cafile = "/ca" }
      local ask = Ask:new{ ui = ui, settings = settings, memory = memory,
                           plugin_version = "t", cafile = "/ca" }

      RELAY_REPLIES = { "Only answer.", "SWEPT NOTES." }
      ui.highlight.selected_text = FakeSelection("A passage", "/xp/1.0", "/xp/1.9")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("The only question?")

      local before = Store.read(ui.doc_settings)
      local due = Memory.is_due(before.threads[1])
      local folded, failed, reason = memory:fold_all()
      local after = Store.read(ui.doc_settings)

      return table.concat({
        "due=" .. tostring(due),
        "folded=" .. folded,
        "failed=" .. failed,
        "summary=" .. tostring(after.memory and after.memory.summary),
        "counter=" .. tostring(after.threads[1].summarized_count),
      }, "\\n")
    `)

    // Two turns is under the automatic threshold, which is exactly why the
    // manual sweep must not inherit it.
    expect(report).toContain('due=false')
    expect(report).toContain('folded=1')
    expect(report).toContain('failed=0')
    expect(report).toContain('summary=SWEPT NOTES.')
    expect(report).toContain('counter=2')
  })

  it('leaves the notes and the counter alone when a fold fails', () => {
    const report = runLua(`
      local Memory = require("marginalia_memory")
      local Store = require("marginalia_store")

      local ui = FakeUI()
      local memory = Memory:new{ ui = ui, settings = FakeSettings(),
                                 plugin_version = "t", cafile = "/ca" }

      Store.write(ui.doc_settings, {
        version = 1,
        memory = { summary = "Existing notes.", updated_at = "2026-08-01 10:00:00" },
        threads = {{
          id = "koreader:t1", created_at = "2026-08-01 10:00:00",
          messages = {
            { id = "m1", role = "user", content = "one" },
            { id = "m2", role = "assistant", content = "two" },
            { id = "m3", role = "user", content = "three" },
            { id = "m4", role = "assistant", content = "four" },
          },
        }},
      })

      RELAY_FAIL = "the relay refused"
      local ok, reason = memory:fold("koreader:t1")
      local after = Store.read(ui.doc_settings)

      return table.concat({
        "ok=" .. tostring(ok),
        "reason=" .. tostring(reason),
        "summary=" .. after.memory.summary,
        "counter=" .. tostring(after.threads[1].summarized_count),
      }, "\\n")
    `)

    expect(report).toContain('ok=false')
    expect(report).toContain('reason=the relay refused')
    // Untouched, so the same turns are folded on the next attempt.
    expect(report).toContain('summary=Existing notes.')
    expect(report).toContain('counter=nil')
  })

  it('keeps one previous digest and can put it back', () => {
    const report = runLua(`
      local Memory = require("marginalia_memory")
      local ui = FakeUI()
      local memory = Memory:new{ ui = ui, settings = FakeSettings(), plugin_version = "t", cafile = "/ca" }

      memory:save("First version.")
      memory:save("Second version.")
      local before = memory:current()
      local undone = memory:undo()
      local after = memory:current()

      memory:save("")
      local cleared = memory:current()

      return table.concat({
        "current=" .. before.summary,
        "previous=" .. tostring(before.previous),
        "undone=" .. tostring(undone),
        "after_undo=" .. after.summary,
        "cleared_summary=" .. tostring(cleared and cleared.summary),
        "cleared_previous=" .. tostring(cleared and cleared.previous),
      }, "\\n")
    `)

    expect(report).toContain('current=Second version.')
    expect(report).toContain('previous=First version.')
    expect(report).toContain('undone=true')
    expect(report).toContain('after_undo=First version.')
    // Clearing keeps what it cleared, which is what makes it recoverable.
    expect(report).toContain('cleared_summary=nil')
    expect(report).toContain('cleared_previous=First version.')
  })
})
