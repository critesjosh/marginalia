--[[--
The list of a book's conversations, and the way back into one.

This started life as a single scrolling document of every conversation, on the
argument that paging a menu costs more e-ink refreshes than reading past what
you did not want. That was wrong in use: a list you cannot act on is not a way
back into a conversation, it is a wall of text, and the one thing you actually
want from it — carry on where we left off — was missing.

So it is a menu. Each row names a conversation, says where in the book it was
and how many turns it holds, and choosing one opens it with **Ask a follow-up**
on it.

@module marginalia.conversations
--]]

local Menu = require("ui/widget/menu")
local Screen = require("device").screen
local UIManager = require("ui/uimanager")
local _ = require("gettext")
local T = require("ffi/util").template

local Store = require("marginalia_store")
local View = require("marginalia_view")

local Conversations = {}

function Conversations:new(o)
    o = o or {}
    setmetatable(o, self)
    self.__index = self
    return o
end

--- Keeps a row to one line's worth of title on a narrow screen.
local function shorten(text, limit)
    text = (text or ""):gsub("%s+", " "):gsub("^ ", ""):gsub(" $", "")
    if text == "" then return _("Untitled") end

    local offsets = {}
    for position in text:gmatch("()[^\128-\191]") do
        offsets[#offsets + 1] = position
    end
    if #offsets <= limit then return text end
    return text:sub(1, offsets[limit] - 1) .. "…"
end

--[[--
One row per conversation, most recently active first.

The same ordering as the document this replaced, and for the same reason: the
conversation you want is usually the one you were last in.
--]]
function Conversations:rows(threads)
    local ordered = {}
    for index, thread in ipairs(threads) do
        ordered[#ordered + 1] = { thread = thread, index = index }
    end
    table.sort(ordered, function(a, b)
        local left, right = View.last_activity(a.thread), View.last_activity(b.thread)
        if left ~= right then return left > right end
        return a.index > b.index
    end)

    local rows = {}
    for _, entry in ipairs(ordered) do
        local thread = entry.thread
        local turns = View.turn_count(thread)
        local where = View.heading(thread)

        rows[#rows + 1] = {
            text = shorten(thread.title or thread.seed_text, 60),
            mandatory = tostring(turns),
            -- The chapter and time go under the title rather than into it, so a
            -- long passage still reads as the thing it is.
            bidi_wrap_func = nil,
            sub_item_table = nil,
            marginalia_thread = thread,
            marginalia_where = where,
        }
    end
    return rows
end

--[[--
Shows the list.

@param on_select called with the chosen thread
--]]
function Conversations:show(on_select)
    local data = Store.read(self.ui.doc_settings)
    local threads = data.threads or {}

    if #threads == 0 then
        local InfoMessage = require("ui/widget/infomessage")
        UIManager:show(InfoMessage:new{
            text = _("No conversations in this book yet. Select a passage and choose Ask Marginalia."),
        })
        return
    end

    local rows = self:rows(threads)
    -- The subtitle lives on the row's own text, two lines, because Menu has no
    -- second line of its own for an item.
    for _, row in ipairs(rows) do
        if row.marginalia_where ~= "" then
            row.text = row.text .. "\n" .. row.marginalia_where
        end
    end

    local menu
    menu = Menu:new{
        title = T(_("Conversations (%1)"), #threads),
        item_table = rows,
        is_borderless = true,
        is_popout = false,
        covers_fullscreen = true,
        width = Screen:getWidth(),
        height = Screen:getHeight(),
        -- Rows carry a title and a place, so they need the room.
        multilines_show_more_text = true,
        close_callback = function() UIManager:close(menu) end,
        onMenuSelect = function(_self, item)
            UIManager:close(menu)
            on_select(item.marginalia_thread)
        end,
    }
    UIManager:show(menu)
end

return Conversations
