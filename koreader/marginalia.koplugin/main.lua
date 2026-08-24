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
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local _ = require("gettext")

local Ask = require("marginalia_ask")
local Handoff = require("marginalia_handoff")
local TLS = require("marginalia_tls")

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

    self.ask = Ask:new{
        ui = self.ui,
        settings = self.settings,
        plugin_version = VERSION,
        cafile = DataStorage:getDataDir() .. "/data/ca-bundle.crt",
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
end

function Marginalia:onMarginaliaExport()
    self.handoff:export()
    return true
end

function Marginalia:addToHighlightDialog()
    -- The registered function is called as fn(ReaderHighlight, index); the
    -- index is of no use here, so only the first argument is taken.
    self.ui.highlight:addToHighlightDialog("12_ask_marginalia", function(highlight)
        return {
            text = _("Ask Marginalia"),
            callback = function()
                self.ask:from_selection(highlight)
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
