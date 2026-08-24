--[[--
A KOReader small enough to run in a test.

Only what the plugin actually touches, and no more. The point is to exercise the
plugin's own modules unchanged — its store, its ask flow, its memory — so the
wiring between them is under test rather than reimplemented here.

Two stubs do real work rather than nothing:

- `Trapper:dismissableRunInSubprocess` runs the task in-process and returns it,
  which is what it does anyway when nothing forks.
- `Relay.post` is replaced by a queue of canned replies, and every request is
  recorded, so a scenario can assert on what was actually sent.

`InputDialog` collects the dialog and exposes `ANSWER_QUESTION`, because the ask
flow is callback-shaped: the question arrives when the reader taps Ask, and a
test has to be able to do that.
--]]

-- Scenario-visible state.
RELAY_REPLIES = {}      -- canned replies, consumed in order
RELAY_REQUESTS = {}     -- every system prompt sent
RELAY_FAIL = nil        -- when set, every call fails with this reason
INPUT_DIALOGS = {}      -- dialogs shown
SHOWN = {}              -- text of every TextViewer shown
VIEWERS = {}            -- the TextViewer widgets themselves
MESSAGES = {}           -- text of every InfoMessage shown
MENUS = {}              -- every Menu shown
BUTTON_DIALOGS = {}     -- every ButtonDialog shown

package.loaded["logger"] = setmetatable({}, { __index = function() return function() end end })
package.loaded["gettext"] = setmetatable({
    ngettext = function(one, many, n) return n == 1 and one or many end,
}, { __call = function(_, text) return text end })

package.loaded["ffi/util"] = {
    template = function(text, ...)
        local args = { ... }
        return (text:gsub("%%(%d)", function(index) return tostring(args[tonumber(index)]) end))
    end,
}

package.loaded["ffi/sha2"] = {
    -- Not SHA-256, but stable and injective enough that ids behave.
    sha256 = function(text)
        local hash = 5381
        for index = 1, #text do
            hash = (hash * 33 + text:byte(index)) % 4294967296
        end
        local hex, value = {}, hash
        for position = 8, 1, -1 do
            local nibble = value % 16
            hex[position] = ("0123456789abcdef"):sub(nibble + 1, nibble + 1)
            value = (value - nibble) / 16
        end
        return table.concat(hex):rep(8)
    end,
}

package.loaded["util"] = {
    cleanupSelectedText = function(text)
        return (text:gsub("^%s+", ""):gsub("%s+$", ""))
    end,
}

package.loaded["ui/event"] = { new = function(_, name, payload)
    return { name = name, payload = payload }
end }

package.loaded["ui/uimanager"] = {
    show = function(_, widget)
        if widget and widget.__kind == "textviewer" then
            SHOWN[#SHOWN + 1] = widget.text or ""
            VIEWERS[#VIEWERS + 1] = widget
        elseif widget and widget.__kind == "infomessage" then
            MESSAGES[#MESSAGES + 1] = widget.text or ""
        end
    end,
    close = function() end,
}

package.loaded["ui/widget/infomessage"] = { new = function(_, spec)
    spec.__kind = "infomessage"
    return spec
end }

package.loaded["ui/widget/textviewer"] = { new = function(_, spec)
    spec.__kind = "textviewer"
    return spec
end }

package.loaded["ui/widget/confirmbox"] = { new = function(_, spec) return spec end }
package.loaded["ui/widget/buttondialog"] = { new = function(_, spec)
    spec.__kind = "buttondialog"
    BUTTON_DIALOGS[#BUTTON_DIALOGS + 1] = spec
    return spec
end }

package.loaded["ui/widget/menu"] = { new = function(_, spec)
    spec.__kind = "menu"
    MENUS[#MENUS + 1] = spec
    return spec
end }

--- Chooses a row of the most recent menu by its visible text.
function CHOOSE_ROW(fragment)
    local menu = MENUS[#MENUS]
    for _, row in ipairs(menu.item_table) do
        if row.text:find(fragment, 1, true) then
            menu.onMenuSelect(menu, row)
            return
        end
    end
    error("no menu row matching " .. fragment)
end

--- Taps a button on the most recent dialog or viewer by its label.
function TAP_BUTTON(widget, label)
    for _, row in ipairs(widget.buttons or widget.buttons_table or {}) do
        for _, button in ipairs(row) do
            if button.text == label then
                if button.enabled == false then error(label .. " is disabled") end
                button.callback()
                return
            end
        end
    end
    error("no button " .. label)
end

package.loaded["ui/widget/inputdialog"] = { new = function(_, spec)
    spec.getInputText = function() return spec.__answer end
    spec.onShowKeyboard = function() end
    INPUT_DIALOGS[#INPUT_DIALOGS + 1] = spec
    return spec
end }

--- Taps "Ask" on the most recent dialog with the given text.
function ANSWER_QUESTION(text)
    local dialog = INPUT_DIALOGS[#INPUT_DIALOGS]
    dialog.__answer = text
    for _, row in ipairs(dialog.buttons) do
        for _, button in ipairs(row) do
            if button.text == "Ask" then button.callback() return end
        end
    end
    error("no Ask button on the dialog")
end

package.loaded["ui/network/manager"] = {
    runWhenOnline = function(_, callback) callback() end,
}

package.loaded["ui/trapper"] = {
    wrap = function(_, task) return task() end,
    -- Nothing forks here, so the task simply runs. `true` is "not dismissed".
    dismissableRunInSubprocess = function(_, task) return true, task() end,
    info = function() return true end,
}

package.loaded["datastorage"] = {
    getDataDir = function() return "/data" end,
    getFullDataDir = function() return "/data" end,
}
package.loaded["device"] = { screen = {
    getHeight = function() return 800 end,
    getWidth = function() return 600 end,
} }
package.loaded["version"] = { getShortVersion = function() return "v-test" end }
package.loaded["dispatcher"] = { registerAction = function() end }
package.loaded["libs/libkoreader-lfs"] = {
    attributes = function() return nil end,
    mkdir = function() return true end,
}
package.loaded["rapidjson"] = { encode = function() return "{}" end, decode = function() return {} end }
package.loaded["socket"] = { try = function(ok, err) if not ok then error(err, 0) end end }
package.loaded["socket.http"] = { request = function() return nil, "not wired" end }
package.loaded["ltn12"] = { source = { string = function() end } }
package.loaded["socketutil"] = {
    set_timeout = function() end, reset_timeout = function() end,
}

--- A sidecar that behaves like `LuaSettings`: in memory, flushed on demand.
local function FakeDocSettings()
    return {
        store = {},
        flushes = 0,
        readSetting = function(self, key)
            if key == "doc_pages" then return 100 end
            return self.store[key]
        end,
        saveSetting = function(self, key, value) self.store[key] = value end,
        flush = function(self) self.flushes = self.flushes + 1 end,
    }
end

function FakeSelection(text, pos0, pos1)
    return { text = text, pos0 = pos0, pos1 = pos1 }
end

function FakeUI()
    local ui
    ui = {
        rolling = true,
        doc_props = { title = "Moby Dick", authors = "Herman Melville" },
        doc_settings = FakeDocSettings(),
        document = {
            file = "/books/moby.epub",
            getPageFromXPointer = function() return 9 end,
        },
        toc = { getTocTitleByPage = function() return "CHAPTER 9. The Sermon." end },
        annotation = {
            annotations = {},
            addItem = function(self, item)
                item.datetime = "2026-08-24 10:00:00"
                item.pageno = 9
                table.insert(self.annotations, item)
                return #self.annotations
            end,
        },
        highlight = {
            selected_text = nil,
            onClose = function() end,
            getSelectedWordContext = function()
                return "Before the passage.", "After the passage."
            end,
        },
        view = {
            highlight = { saved_drawer = "lighten", saved_color = "gray" },
            footer = { maybeUpdateFooter = function() end },
        },
        menu = { registerToMainMenu = function() end },
        handleEvent = function() end,
    }
    return ui
end

function FakeSettings()
    return { endpoint = "https://example.test/api/chat", spoiler_guard = true }
end

--- Stands in for a memory object where a scenario does not want folding.
function FakeMemory()
    return { fold = function() return false, "nothing new to fold in" end }
end

--[[--
Replaces the relay once `marginalia_relay` has been loaded.

Called from the harness after the modules are in place, because it has to
overwrite a function on the real module rather than stand in for it.
--]]
function INSTALL_FAKE_RELAY()
    local Relay = package.loaded["marginalia_relay"]
    Relay.post = function(_, messages, _, _)
        RELAY_REQUESTS[#RELAY_REQUESTS + 1] = messages[1].content
        if RELAY_FAIL then return { ok = false, error = RELAY_FAIL } end
        local reply = table.remove(RELAY_REPLIES, 1)
        if not reply then return { ok = false, error = "no canned reply left" } end
        return { ok = true, text = reply }
    end
end
