--[[--
Rendering saved conversations as readable text.

Threads have been sitting in the book's sidecar since the plugin could ask
anything, with nothing to read them back. This is that reader, and it is only
formatting: one function turns a thread into a transcript, another lays out a
whole book's worth for a single scroll.

Everything renders to plain text rather than to a widget on purpose. The same
transcript is what **Save to note** writes into a KOReader note, and having one
function produce both is what stops the note and the on-screen view drifting
into two different formats of the same conversation.

No `require` of anything: this module is pure so it can be tested off-device.

@module marginalia.view
--]]

local View = {}

--- Marks a turn in a transcript. Short, because e-ink lines are precious.
local PREFIX = { user = "Q: ", assistant = "A: " }

local function trimmed(value)
    if type(value) ~= "string" then return nil end
    local clean = value:gsub("^%s+", ""):gsub("%s+$", "")
    if clean == "" then return nil end
    return clean
end

--[[--
One thread as a transcript.

@param thread a stored thread (see marginalia_store.lua)
@treturn string
--]]
function View.transcript(thread)
    local lines = {}
    for _, message in ipairs(thread and thread.messages or {}) do
        local content = trimmed(message.content)
        if content then
            table.insert(lines, (PREFIX[message.role] or "") .. content)
        end
    end
    return table.concat(lines, "\n\n")
end

--- How many turns a thread holds, for a heading that says so.
function View.turn_count(thread)
    local count = 0
    for _, message in ipairs(thread and thread.messages or {}) do
        if trimmed(message.content) then count = count + 1 end
    end
    return count
end

--[[--
A heading for one thread: where in the book it was, and when.

The passage itself is not repeated here. It is the first thing the transcript's
own question is about, and on a six-inch screen a quoted paragraph above every
conversation is most of the screen.
--]]
function View.heading(thread)
    local parts = {}
    local chapter = trimmed(thread and thread.chapter)
    if chapter then table.insert(parts, chapter) end
    if type(thread and thread.progress) == "number" then
        table.insert(parts, string.format("%d%%", math.floor(thread.progress * 100 + 0.5)))
    end
    local created = trimmed(thread and thread.created_at)
    if created then table.insert(parts, created) end
    return table.concat(parts, " · ")
end

--[[--
One thread, ready for a text viewer: heading, then the exchange.
--]]
function View.thread_document(thread)
    local heading = View.heading(thread)
    local body = View.transcript(thread)
    if heading == "" then return body end
    if body == "" then return heading end
    return heading .. "\n\n" .. body
end

--- Separates threads in the book-wide view. A rule, so a scroll has landmarks.
local RULE = "\n\n" .. ("─"):rep(24) .. "\n\n"

--[[--
Every conversation in the book, newest first.

Newest first because the reason to open this is usually the thing just asked,
and scrolling back through an e-ink document to reach it is the slowest possible
way to find it.

@param threads array of stored threads
@param empty_text what to say when there are none
@treturn string
--]]
function View.book_document(threads, empty_text)
    threads = threads or {}
    if #threads == 0 then return empty_text or "" end

    -- Sorted on a copy: this is the live table out of the sidecar, and
    -- reordering it in place would change what the next export writes.
    local ordered = {}
    for index, thread in ipairs(threads) do
        ordered[index] = { thread = thread, index = index }
    end
    table.sort(ordered, function(a, b)
        local left = a.thread.created_at or ""
        local right = b.thread.created_at or ""
        -- Sidecar timestamps sort correctly as strings, being fixed-width and
        -- most-significant-first. Ties fall back to the order they were stored
        -- in, so the sort stays stable rather than depending on the algorithm.
        if left ~= right then return left > right end
        return a.index > b.index
    end)

    local blocks = {}
    for _, entry in ipairs(ordered) do
        local title = trimmed(entry.thread.title)
        local heading = View.heading(entry.thread)
        local body = View.transcript(entry.thread)

        local block = {}
        if title then table.insert(block, title) end
        if heading ~= "" then table.insert(block, heading) end
        if body ~= "" then table.insert(block, body) end
        if #block > 0 then table.insert(blocks, table.concat(block, "\n\n")) end
    end

    if #blocks == 0 then return empty_text or "" end
    return table.concat(blocks, RULE)
end

return View
