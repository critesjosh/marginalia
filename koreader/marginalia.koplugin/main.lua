--[[--
Marginalia for KOReader.

Two things: ask an AI companion about the passage you just highlighted, and
export a book's highlights for the Marginalia web reader at
<https://lexici.netlify.app>.

Questions go to that site's relay, which holds the inference key server-side and
pins the model, so there is no key to configure here and no account to make. The
relay is the same one the web app uses, so a conversation started on an
e-reader reads exactly like one started in the browser.

@module koplugin.marginalia
--]]

local DataStorage = require("datastorage")
local Dispatcher = require("dispatcher")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local NetworkMgr = require("ui/network/manager")
local TextViewer = require("ui/widget/textviewer")
local Trapper = require("ui/trapper")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local _ = require("gettext")
local N_ = _.ngettext
local T = require("ffi/util").template

local ConfirmBox = require("ui/widget/confirmbox")

local Ask = require("marginalia_ask")
local Handoff = require("marginalia_handoff")
local Memory = require("marginalia_memory")
local Store = require("marginalia_store")
local TLS = require("marginalia_tls")
local View = require("marginalia_view")

local VERSION = "1.0.0"

--- The public deployment. Editable, because this repo also deploys to
--- Cloudflare and because a self-hoster should not have to patch the plugin.
local DEFAULT_ENDPOINT = "https://lexici.netlify.app/api/chat"

local Marginalia = WidgetContainer:extend{
    name = "marginalia",
    is_doc_only = true,
}

function Marginalia:init()
    self.settings = G_reader_settings:readSetting("marginalia", {
        endpoint = DEFAULT_ENDPOINT,
        spoiler_guard = true,
    })
    -- A settings table written by an older version may be missing keys the
    -- current one reads, and `readSetting`'s default only applies when the whole
    -- table is absent.
    if self.settings.endpoint == nil then self.settings.endpoint = DEFAULT_ENDPOINT end
    if self.settings.spoiler_guard == nil then self.settings.spoiler_guard = true end

    local cafile = DataStorage:getDataDir() .. "/data/ca-bundle.crt"

    self.memory = Memory:new{
        ui = self.ui,
        settings = self.settings,
        plugin_version = VERSION,
        cafile = cafile,
    }
    self.ask = Ask:new{
        ui = self.ui,
        settings = self.settings,
        memory = self.memory,
        plugin_version = VERSION,
        cafile = cafile,
    }
    self.handoff = Handoff:new{
        ui = self.ui,
        plugin_version = VERSION,
    }

    self:onDispatcherRegisterActions()
    self.ui.menu:registerToMainMenu(self)
    self:addToHighlightDialog()
end

function Marginalia:onDispatcherRegisterActions()
    Dispatcher:registerAction("marginalia_export", {
        category = "none",
        event = "MarginaliaExport",
        title = _("Export highlights for Marginalia"),
        reader = true,
    })
    Dispatcher:registerAction("marginalia_conversations", {
        category = "none",
        event = "MarginaliaConversations",
        title = _("Marginalia conversations"),
        reader = true,
    })
    Dispatcher:registerAction("marginalia_notes", {
        category = "none",
        event = "MarginaliaNotes",
        title = _("Marginalia notes on this book"),
        reader = true,
    })
end

--[[--
Every conversation in this book, in one scroll.

A single document rather than a list to pick from: on e-ink, paging through a
menu to find the one you meant costs more full refreshes than simply reading
past the ones you did not. They are newest first for the same reason.
--]]
function Marginalia:showConversations()
    local data = Store.read(self.ui.doc_settings)
    local threads = data.threads or {}

    if #threads == 0 then
        UIManager:show(InfoMessage:new{
            text = _("No conversations in this book yet. Select a passage and choose Ask Marginalia."),
        })
        return
    end

    local count = #threads
    UIManager:show(TextViewer:new{
        -- The number goes through `ngettext` and then the template, and is
        -- passed twice on purpose: `ngettext` picks the plural form for the
        -- language and does nothing about the placeholder.
        title = T(N_("1 conversation", "%1 conversations", count), count),
        text = View.book_document(threads),
        text_type = "lookup",
    })
end

function Marginalia:onMarginaliaConversations()
    self:showConversations()
    return true
end

--[[--
The book's running notes, and the ways to correct them.
--]]
function Marginalia:showNotes()
    local memory = self.memory:current()
    local summary = memory and memory.summary
    local recoverable = memory and memory.previous

    if (not summary or summary == "") and not recoverable then
        UIManager:show(InfoMessage:new{
            text = _("No notes on this book yet. They build up as you ask about it."),
        })
        return
    end

    -- Cleared notes still open this screen when there is something to put back.
    -- Undo lives here and nowhere else, so returning early on an empty digest
    -- would leave the previous one stored and unreachable.
    local viewer
    local has_summary = summary ~= nil and summary ~= ""

    local buttons = {{
        {
            text = _("Edit"),
            enabled = has_summary,
            callback = function()
                UIManager:close(viewer)
                self:editNotes(summary)
            end,
        },
        {
            text = _("Clear"),
            enabled = has_summary,
            callback = function()
                UIManager:show(ConfirmBox:new{
                    text = _("Clear this book's notes? The conversations themselves are kept."),
                    ok_text = _("Clear"),
                    ok_callback = function()
                        self.memory:save("")
                        UIManager:close(viewer)
                    end,
                })
            end,
        },
    }, {
        {
            text = _("Undo last change"),
            enabled = recoverable ~= nil,
            callback = function()
                if self.memory:undo() then
                    UIManager:close(viewer)
                    self:showNotes()
                end
            end,
        },
        {
            text = _("Close"),
            callback = function() UIManager:close(viewer) end,
        },
    }}

    local body = has_summary
        and (summary .. "\n\n— updated " .. (memory.updated_at or "?"))
        or _("These notes are cleared. The version before that is still here — Undo puts it back.")

    viewer = TextViewer:new{
        title = _("Notes on this book"),
        text = body,
        text_type = "lookup",
        buttons_table = buttons,
    }
    UIManager:show(viewer)
end

function Marginalia:editNotes(summary)
    local dialog
    dialog = InputDialog:new{
        title = _("Notes on this book"),
        input = summary,
        allow_newline = true,
        -- Tall, because this is a paragraph of notes rather than a question.
        text_height = math.floor(require("device").screen:getHeight() * 0.4),
        description = _("Later updates merge into whatever is here, so an edit carries forward rather than being summarised away."),
        buttons = {{
            {
                text = _("Cancel"),
                id = "close",
                callback = function() UIManager:close(dialog) end,
            },
            {
                -- No `is_enter_default`: `allow_newline` deliberately turns the
                -- enter callback off, so claiming it here would be inert.
                text = _("Save"),
                callback = function()
                    self.memory:save(dialog:getInputText() or "")
                    UIManager:close(dialog)
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--[[--
Folds every conversation with a backlog into the notes.

The automatic path only ever folds the conversation being continued, so a thread
asked about once and left alone is only ever caught up here. Unlike the
automatic path this reports what happened: the reader asked for it, and silence
would read as a failure.
--]]
function Marginalia:updateNotes()
    NetworkMgr:runWhenOnline(function()
        Trapper:wrap(function()
            local folded, failed, reason = self.memory:fold_all()

            if failed > 0 and reason ~= "cancelled" then
                -- Reported even when some folds succeeded: the conversations
                -- that failed are still pending, and "Notes updated" would say
                -- the opposite of that.
                UIManager:show(InfoMessage:new{
                    text = folded > 0
                        and T(_("Notes updated from %1 of %2 conversations. The rest failed: %3"),
                            folded, folded + failed, tostring(reason))
                        or T(_("Could not update the notes: %1"), tostring(reason)),
                    timeout = 8,
                })
            elseif folded > 0 then
                UIManager:show(InfoMessage:new{ text = _("Notes updated."), timeout = 2 })
            elseif reason == "nothing new to fold in" then
                UIManager:show(InfoMessage:new{
                    text = _("Nothing new to add to the notes."),
                    timeout = 3,
                })
            end
        end)
    end)
end

function Marginalia:onMarginaliaNotes()
    self:showNotes()
    return true
end

function Marginalia:onMarginaliaExport()
    self.handoff:export()
    return true
end

function Marginalia:addToHighlightDialog()
    -- Called as fn(ReaderHighlight, index). For a popup opened on a saved
    -- highlight the index names its row in `annotations`, and it is the only
    -- reliable way back to that row: KOReader hands the menu a deep copy, so
    -- comparing positions finds nothing for a paging document, whose positions
    -- are tables. A fresh selection has no index because it has no annotation.
    self.ui.highlight:addToHighlightDialog("12_ask_marginalia", function(highlight, index)
        return {
            text = _("Ask Marginalia"),
            callback = function()
                self.ask:from_selection(highlight, index)
            end,
        }
    end)
end

function Marginalia:addToMainMenu(menu_items)
    menu_items.marginalia = {
        text = _("Marginalia"),
        sorting_hint = "more_tools",
        sub_item_table = {
            {
                text = _("Conversations in this book"),
                keep_menu_open = false,
                callback = function() self:showConversations() end,
                help_text = _("Everything you have asked about this book, newest first. Also reachable from a passage you have already asked about."),
            },
            {
                text = _("Notes on this book"),
                keep_menu_open = false,
                callback = function() self:showNotes() end,
                help_text = _("The running summary of what you and Marginalia have worked out about this book. It is sent with every question, so a later one can build on an earlier one."),
            },
            {
                text = _("Update notes now"),
                keep_menu_open = false,
                callback = function() self:updateNotes() end,
                help_text = _("Folds every conversation with something new in it into the notes. Asking a follow-up does this for that conversation on its own."),
                separator = true,
            },
            {
                text = _("Export highlights for Marginalia"),
                keep_menu_open = false,
                callback = function() self.handoff:export() end,
            },
            {
                text = _("Avoid spoilers"),
                checked_func = function() return self.settings.spoiler_guard end,
                callback = function()
                    self.settings.spoiler_guard = not self.settings.spoiler_guard
                    self:saveSettings()
                end,
                help_text = _("Asks the model not to reveal anything past your current position unless you ask for it."),
                separator = true,
            },
            {
                text_func = function()
                    return _("Relay: ") .. (self.settings.endpoint or "")
                end,
                keep_menu_open = true,
                callback = function(touchmenu_instance)
                    self:editEndpoint(touchmenu_instance)
                end,
                help_text = _("Where questions are sent. The default is the public Marginalia deployment; change it only if you host your own."),
            },
        },
    }
end

function Marginalia:editEndpoint(touchmenu_instance)
    local dialog
    dialog = InputDialog:new{
        title = _("Marginalia relay"),
        input = self.settings.endpoint or DEFAULT_ENDPOINT,
        input_hint = DEFAULT_ENDPOINT,
        description = _("Must be an https:// address. Questions and passages travel over this connection, so it is verified against the device's certificate store."),
        buttons = {{
            {
                text = _("Cancel"),
                id = "close",
                callback = function() UIManager:close(dialog) end,
            },
            {
                text = _("Use default"),
                callback = function()
                    self.settings.endpoint = DEFAULT_ENDPOINT
                    self:saveSettings()
                    UIManager:close(dialog)
                    if touchmenu_instance then touchmenu_instance:updateItems() end
                end,
            },
            {
                text = _("Save"),
                is_enter_default = true,
                callback = function()
                    local endpoint = (dialog:getInputText() or ""):gsub("^%s+", ""):gsub("%s+$", "")
                    local usable, why = TLS.check_endpoint(endpoint)
                    if not usable then
                        UIManager:show(InfoMessage:new{ text = why })
                        return
                    end
                    self.settings.endpoint = endpoint
                    self:saveSettings()
                    UIManager:close(dialog)
                    if touchmenu_instance then touchmenu_instance:updateItems() end
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

function Marginalia:saveSettings()
    G_reader_settings:saveSetting("marginalia", self.settings)
end

return Marginalia
