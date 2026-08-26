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
    'marginalia_tls', 'marginalia_endpoint', 'marginalia_relay', 'marginalia_memory', 'marginalia_ask',
    'marginalia_conversations', 'marginalia_handoff', 'main',
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

  it('leaves room to type a question longer than one line', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local ui = FakeUI()
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "test", cafile = "/ca" }

      -- A passage of several paragraphs, which is what crowds the box: it is
      -- quoted above the input, and the input gets what is left.
      local passage = string.rep("Call me Ishmael. ", 60)
      ui.highlight.selected_text = FakeSelection(passage, "/xp/1.0", "/xp/1.20")
      ask:from_selection(ui.highlight)

      local dialog = INPUT_DIALOGS[1]
      return table.concat({
        "grows=" .. tostring(dialog.use_available_height == true),
        "fixed_height=" .. tostring(dialog.text_height ~= nil),
        "quote_bounded=" .. tostring(#dialog.description < #passage),
        "quote_kept=" .. tostring(dialog.description:find("Call me Ishmael.", 1, true) ~= nil),
        "enter_asks=" .. tostring(dialog.allow_newline ~= true),
      }, "\\n")
    `)

    // The box sizes itself from what the passage and keyboard leave over
    // rather than from a fixed height, and the quote is bounded so that there
    // is something left to size.
    expect(report).toContain('grows=true')
    expect(report).toContain('fixed_height=false')
    expect(report).toContain('quote_bounded=true')
    expect(report).toContain('quote_kept=true')
    expect(report).toContain('enter_asks=true')
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

  it('folds a one-turn conversation in when it is saved to a note', () => {
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

      RELAY_REPLIES = { "Because the prow goes first.", "NOTES: prow imagery." }

      ui.highlight.selected_text = FakeSelection("Father Mapple rose", "/xp/1.0", "/xp/1.20")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("Why a ship's prow?")

      -- One exchange and no follow-up: the automatic path would never fold this.
      local before = Store.read(ui.doc_settings)
      local due = Memory.is_due(before.threads[1])
      local summary_before = before.memory and before.memory.summary

      TAP_BUTTON(VIEWERS[#VIEWERS], "Save to note")

      local after = Store.read(ui.doc_settings)
      return table.concat({
        "due=" .. tostring(due),
        "summary_before=" .. tostring(summary_before),
        "summary=" .. tostring(after.memory and after.memory.summary),
        "counter=" .. tostring(after.threads[1].summarized_count),
        "note_has_q=" .. tostring((ui.annotation.annotations[1].note or ""):find("Q: Why", 1, true) ~= nil),
        "first_message=" .. tostring(MESSAGES[1]),
        "last_message=" .. tostring(MESSAGES[#MESSAGES]),
      }, "\\n")
    `)

    // Two turns is under the automatic threshold, which is the whole point:
    // saving is the reader's signal that this one exchange was worth keeping.
    expect(report).toContain('due=false')
    expect(report).toContain('summary_before=nil')
    expect(report).toContain('summary=NOTES: prow imagery.')
    expect(report).toContain('counter=2')
    // And the note itself, which is what the button says it does.
    expect(report).toContain('note_has_q=true')
    // Two acts, two messages, in that order.
    expect(report).toContain("first_message=Saved to this highlight's note.")
    expect(report).toContain('last_message=Added to the notes on this book.')
  })

  it('still confirms the note when the reader turns down the network', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local Memory = require("marginalia_memory")
      local Store = require("marginalia_store")

      local ui = FakeUI()
      local settings = FakeSettings()
      local memory = Memory:new{ ui = ui, settings = settings, plugin_version = "t", cafile = "/ca" }
      local ask = Ask:new{ ui = ui, settings = settings, memory = memory,
                           plugin_version = "t", cafile = "/ca" }

      RELAY_REPLIES = { "An answer." }
      ui.highlight.selected_text = FakeSelection("A passage", "/xp/1.0", "/xp/1.9")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("A question?")

      -- The Wi-Fi prompt is declined, so runWhenOnline never calls back.
      MESSAGES = {}
      NETWORK_DECLINED = true
      TAP_BUTTON(VIEWERS[#VIEWERS], "Save to note")
      NETWORK_DECLINED = false

      local after = Store.read(ui.doc_settings)
      return table.concat({
        "messages=" .. #MESSAGES,
        "message=" .. tostring(MESSAGES[1]),
        "note_saved=" .. tostring((ui.annotation.annotations[1].note or "") ~= ""),
        "summary=" .. tostring(after.memory and after.memory.summary),
        "pending=" .. Memory.pending_count(after.threads[1]),
      }, "\\n")
    `)

    // The note is local and already written; saying nothing about it because a
    // network prompt was declined would report a success as a silence.
    expect(report).toContain('messages=1')
    expect(report).toContain("message=Saved to this highlight's note.")
    expect(report).toContain('note_saved=true')
    // And the fold is deferred, not lost: the turns are still waiting for the
    // next follow-up or for Update notes now.
    expect(report).toContain('summary=nil')
    expect(report).toContain('pending=2')
  })

  it('saves the note without a fold when there is nothing pending', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local ui = FakeUI()
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "t", cafile = "/ca" }

      RELAY_REPLIES = { "An answer." }
      ui.highlight.selected_text = FakeSelection("A passage", "/xp/1.0", "/xp/1.9")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("A question?")

      -- As it stands after a fold: every turn already accounted for.
      local Store = require("marginalia_store")
      local data = Store.read(ui.doc_settings)
      data.threads[1].summarized_count = #data.threads[1].messages
      Store.write(ui.doc_settings, data)

      local viewer = VIEWERS[#VIEWERS]
      TAP_BUTTON(viewer, "Save to note")
      TAP_BUTTON(viewer, "Save to note")

      return table.concat({
        "folds=" .. #ask.memory.folds,
        "note_saved=" .. tostring((ui.annotation.annotations[1].note or "") ~= ""),
        "message=" .. tostring(MESSAGES[#MESSAGES]),
      }, "\\n")
    `)

    // Re-saving an already-folded conversation stays local: no relay, and no
    // network prompt in front of somebody who only wanted the note rewritten.
    expect(report).toContain('folds=0')
    expect(report).toContain('note_saved=true')
    expect(report).toContain("message=Saved to this highlight's note.")
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

  it('lists conversations and carries one on from the list', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local Conversations = require("marginalia_conversations")

      local ui = FakeUI()
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "t", cafile = "/ca" }
      local list = Conversations:new{ ui = ui }

      -- Two conversations on two passages.
      RELAY_REPLIES = { "Answer about Mapple.", "Answer about the whale.", "Follow-up answer." }
      ui.highlight.selected_text = FakeSelection("Father Mapple rose", "/xp/1.0", "/xp/1.20")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("About Mapple?")

      ui.highlight.selected_text = FakeSelection("The white whale", "/xp/9.0", "/xp/9.15")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("About the whale?")

      local annotations_before = #ui.annotation.annotations

      -- Open the list and carry on the older conversation.
      list:show(function(thread) ask:continue_thread(thread) end)
      local menu = MENUS[#MENUS]
      local rows = {}
      for _, row in ipairs(menu.item_table) do rows[#rows + 1] = row.text end

      CHOOSE_ROW("Father Mapple")
      local viewer = VIEWERS[#VIEWERS]
      TAP_BUTTON(viewer, "Ask a follow-up")
      ANSWER_QUESTION("And what follows?")

      local Store = require("marginalia_store")
      local data = Store.read(ui.doc_settings)
      local mapple
      for _, t in ipairs(data.threads) do
        if (t.seed_text or ""):find("Mapple", 1, true) then mapple = t end
      end

      return table.concat({
        "rows=" .. #menu.item_table,
        "first_row=" .. rows[1]:gsub(string.char(10), " / "),
        "turn_counts=" .. menu.item_table[1].mandatory .. "," .. menu.item_table[2].mandatory,
        "viewer_had_transcript=" .. tostring(SHOWN[#SHOWN]:find("Answer about Mapple.", 1, true) ~= nil),
        "mapple_turns=" .. #mapple.messages,
        "threads=" .. #data.threads,
        "annotations_before=" .. annotations_before,
        "annotations_after=" .. #ui.annotation.annotations,
      }, "; ")
    `)

    expect(report).toContain('rows=2')
    // Most recently active first, and each row says where it was.
    expect(report).toContain('first_row=The white whale / CHAPTER 9. The Sermon.')
    expect(report).toContain('turn_counts=2,2')
    expect(report).toContain('viewer_had_transcript=true')
    // The follow-up landed on the conversation that was chosen...
    expect(report).toContain('mapple_turns=4')
    // ...without starting a second one, or a second highlight for a passage
    // that already had one.
    expect(report).toContain('threads=2')
    expect(report).toContain('annotations_before=2')
    expect(report).toContain('annotations_after=2')
  })

  it('knows whether a passage already has a conversation', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local ui = FakeUI()
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "t", cafile = "/ca" }

      local fresh = FakeSelection("Father Mapple rose", "/xp/1.0", "/xp/1.20")
      ui.highlight.selected_text = fresh
      local before = ask:has_thread(ui.highlight)

      RELAY_REPLIES = { "An answer." }
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("A question?")

      ui.highlight.selected_text = fresh
      local after = ask:has_thread(ui.highlight)
      local by_index = ask:has_thread(ui.highlight, 1)
      local other = ask:has_thread({ selected_text = FakeSelection("Something else", "/xp/5.0", "/xp/5.9") })
      local by_annotation = ask:thread_for_annotation(ui.annotation.annotations[1]) ~= nil

      return table.concat({
        "before=" .. tostring(before),
        "after=" .. tostring(after),
        "by_index=" .. tostring(by_index),
        "other=" .. tostring(other),
        "by_annotation=" .. tostring(by_annotation),
      }, "; ")
    `)

    // This is what names the button, so it has to be right in both directions.
    expect(report).toContain('before=false')
    expect(report).toContain('after=true')
    expect(report).toContain('by_index=true')
    expect(report).toContain('other=false')
    expect(report).toContain('by_annotation=true')
  })

  it('carries a conversation on after its highlight is deleted', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local Store = require("marginalia_store")

      local ui = FakeUI()
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "t", cafile = "/ca" }

      RELAY_REPLIES = { "An answer.", "Another answer." }
      ui.highlight.selected_text = FakeSelection("A passage", "/xp/1.0", "/xp/1.9")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("A question?")

      -- The reader deletes the highlight but keeps the book open.
      ui.annotation.annotations = {}

      local thread = Store.read(ui.doc_settings).threads[1]
      ask:continue_thread(thread)
      local viewer = VIEWERS[#VIEWERS]

      local save_disabled = false
      for _, row in ipairs(viewer.buttons_table) do
        for _, button in ipairs(row) do
          if button.text == "Save to note" then save_disabled = button.enabled == false end
        end
      end

      TAP_BUTTON(viewer, "Ask a follow-up")
      ANSWER_QUESTION("Still there?")

      local after = Store.read(ui.doc_settings)
      return table.concat({
        "save_disabled=" .. tostring(save_disabled),
        "turns=" .. #after.threads[1].messages,
        "threads=" .. #after.threads,
        "annotations=" .. #ui.annotation.annotations,
      }, "; ")
    `)

    // A conversation outlives its mark: it still opens and still continues,
    // and does not resurrect a highlight that was deleted on purpose.
    expect(report).toContain('save_disabled=true')
    expect(report).toContain('turns=4')
    expect(report).toContain('threads=1')
    expect(report).toContain('annotations=0')
  })

  it('survives a paging document, where a position is a table', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local ui = FakeUI()
      ui.rolling = false
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "t", cafile = "/ca" }

      -- A PDF highlight, as KOReader stores one.
      ui.annotation.annotations = {{
        text = "A passage in a PDF",
        page = 12,
        pos0 = { page = 12, x = 40, y = 300 },
        pos1 = { page = 12, x = 380, y = 316 },
        datetime = "2026-08-24 10:00:00",
      }}

      -- Both of these reach external_id, which used to be handed a table.
      local has = ask:has_thread(nil, 1)
      local thread = ask:thread_for_annotation(ui.annotation.annotations[1])

      return "has=" .. tostring(has) .. "; thread=" .. tostring(thread)
    `)

    // No conversation exists, so both answer "no" — the point is that neither
    // raises on the way to saying so.
    expect(report).toContain('has=false')
    expect(report).toContain('thread=nil')
  })

  it('keeps a conversation attached when its highlight is adjusted', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local Store = require("marginalia_store")

      local ui = FakeUI()
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "t", cafile = "/ca" }

      RELAY_REPLIES = { "An answer.", "A follow-up answer." }
      ui.highlight.selected_text = FakeSelection("Father Mapple rose", "/xp/1.0", "/xp/1.20")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("A question?")

      local before = Store.read(ui.doc_settings).threads[1].highlight_ref

      -- The reader nudges the highlight's end, which is a supported KOReader
      -- operation and changes both the text and the start position.
      local annotation = ui.annotation.annotations[1]
      annotation.text = "Father Mapple rose, and in a mild voice"
      annotation.pos0 = "/xp/1.1"

      local thread = ask:thread_for_annotation(annotation)
      local after = Store.read(ui.doc_settings).threads[1].highlight_ref

      -- And continuing from there still lands on the same conversation.
      ask:continue_thread(Store.read(ui.doc_settings).threads[1])
      TAP_BUTTON(VIEWERS[#VIEWERS], "Ask a follow-up")
      ANSWER_QUESTION("Still linked?")

      local data = Store.read(ui.doc_settings)
      return table.concat({
        "found=" .. tostring(thread ~= nil),
        "relinked=" .. tostring(before ~= after),
        "threads=" .. #data.threads,
        "turns=" .. #data.threads[1].messages,
        "annotations=" .. #ui.annotation.annotations,
      }, "; ")
    `)

    // Without the repair the id moves and the conversation is orphaned: the
    // tap offers nothing, and asking again starts a second thread.
    expect(report).toContain('found=true')
    expect(report).toContain('relinked=true')
    expect(report).toContain('threads=1')
    expect(report).toContain('turns=4')
    expect(report).toContain('annotations=1')
  })

  it('does not let a new highlight adopt an existing conversation', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local Store = require("marginalia_store")

      local ui = FakeUI()
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "t", cafile = "/ca" }

      RELAY_REPLIES = { "An answer." }
      ui.highlight.selected_text = FakeSelection("the whale sounded", "/xp/1.0", "/xp/1.17")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("A question?")

      -- A second, unrelated highlight that happens to contain the first's words,
      -- made while the original highlight is still there.
      ui.annotation.annotations[2] = {
        text = "the whale sounded and", pos0 = "/xp/2.0", datetime = "2026-08-24 12:00:00",
      }

      local stolen = ask:thread_for_annotation(ui.annotation.annotations[2])
      local original = ask:thread_for_annotation(ui.annotation.annotations[1])

      return "stolen=" .. tostring(stolen) .. "; original=" .. tostring(original ~= nil)
    `)

    // The original conversation still has its own mark, so it is not looking
    // for a new home; attaching it here would claim a conversation about a
    // passage nobody had one about.
    expect(report).toContain('stolen=nil')
    expect(report).toContain('original=true')
  })

  it('will not adopt a conversation about a passage much shorter than the mark', () => {
    const report = runLua(`
      local Ask = require("marginalia_ask")
      local Store = require("marginalia_store")

      local ui = FakeUI()
      local ask = Ask:new{ ui = ui, settings = FakeSettings(), memory = FakeMemory(),
                           plugin_version = "t", cafile = "/ca" }

      RELAY_REPLIES = { "An answer." }
      ui.highlight.selected_text = FakeSelection("the whale", "/xp/1.0", "/xp/1.9")
      ask:from_selection(ui.highlight)
      ANSWER_QUESTION("A question?")

      -- The original mark is gone, and what is left is a whole paragraph that
      -- merely contains those two words.
      ui.annotation.annotations = {{
        text = "It was late in the day when the whale sounded for the last time, and the boats gave chase.",
        pos0 = "/xp/9.0", datetime = "2026-08-24 12:00:00",
      }}

      local adopted = ask:thread_for_annotation(ui.annotation.annotations[1])
      local thread = Store.read(ui.doc_settings).threads[1]
      local reverse = ask:find_annotation(thread.highlight_ref, thread)

      return "adopted=" .. tostring(adopted) .. "; reverse=" .. tostring(reverse)
    `)

    // A boundary nudge moves a highlight by a word or two. This is a paragraph,
    // so the conversation stays where it is — still reachable from the list.
    expect(report).toContain('adopted=nil')
    expect(report).toContain('reverse=nil')
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

  it('puts every HTTP header on the real table LuaSocket iterates', () => {
    const report = runLua(`
      local Relay = require("marginalia_relay")
      local inherited = setmetatable({
        ["Content-Length"] = "wrong",
      }, {
        __index = {
          ["Content-Type"] = "application/json",
          ["Accept"] = "application/json",
          ["Authorization"] = "Bearer local",
        },
      })

      -- This reproduces the failed implementation: pairs cannot see any of
      -- those inherited values. The helper must receive an ordinary table,
      -- and the result itself must be flat for LuaSocket's own pairs loop.
      local source = {
        ["Content-Type"] = inherited["Content-Type"],
        ["Accept"] = inherited["Accept"],
        ["Authorization"] = inherited["Authorization"],
      }
      local headers = Relay.request_headers(source, 123)
      local count = 0
      for _ in pairs(headers) do count = count + 1 end
      return table.concat({
        "count=" .. count,
        "type=" .. tostring(headers["Content-Type"]),
        "accept=" .. tostring(headers["Accept"]),
        "auth=" .. tostring(headers["Authorization"]),
        "length=" .. tostring(headers["Content-Length"]),
      }, "\\n")
    `)

    expect(report).toContain('count=4')
    expect(report).toContain('type=application/json')
    expect(report).toContain('accept=application/json')
    expect(report).toContain('auth=Bearer local')
    expect(report).toContain('length=123')
  })

  it('puts the conversation list where you go back to things in a book', () => {
    const report = runLua(`
      -- main.lua as the plugin loader gets it; only the menu is exercised,
      -- so the plugin table stands in for an initialised instance.
      local Marginalia = require("main")
      local plugin = setmetatable({
        showConversations = function(self) self.opened = true end,
      }, { __index = Marginalia })

      local menu_items = {}
      plugin:addToMainMenu(menu_items)

      local top = menu_items.marginalia_conversations
      top.callback()

      -- The plugin's own submenu keeps its copy.
      local buried
      for _, row in ipairs(menu_items.marginalia.sub_item_table) do
        -- The relay row labels itself with text_func, so not every row has text.
        if (row.text or ""):find("Conversations", 1, true) then buried = row end
      end

      return table.concat({
        "top_text=" .. tostring(top and top.text),
        "top_hint=" .. tostring(top and top.sorting_hint),
        "opened=" .. tostring(plugin.opened),
        "submenu_hint=" .. tostring(menu_items.marginalia.sorting_hint),
        "submenu_row=" .. tostring(buried and buried.text),
      }, "\\n")
    `)

    // The navigation tab, next to the table of contents and the bookmarks —
    // two taps, not four down a tools submenu.
    expect(report).toContain('top_hint=navi')
    expect(report).toContain('top_text=Marginalia conversations')
    expect(report).toContain('opened=true')
    // Without emptying the plugin's own menu of it.
    expect(report).toContain('submenu_hint=more_tools')
    expect(report).toContain('submenu_row=Conversations in this book')
  })
})
