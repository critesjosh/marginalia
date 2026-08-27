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

--- Byte offset of the start of every UTF-8 character in `s`, plus an end sentinel.
-- A byte begins a character iff it is not a continuation byte (0x80..0xBF).
local function char_offsets(s)
    local offsets = {}
    for position in s:gmatch("()[^\128-\191]") do
        offsets[#offsets + 1] = position
    end
    offsets[#offsets + 1] = #s + 1
    return offsets
end

--[[--
How much of a passage a dialog quotes back before it starts eating the screen.

Generous enough that an ordinary highlight — a sentence, a short paragraph — is
shown whole, and only a selection of several paragraphs is shortened.
--]]
View.EXCERPT_CHARS = 320

--[[--
A passage cut down to something that can sit above an input box.

The point is the room *below* it: the question box is sized from what is left of
the screen once the quoted passage and the keyboard have taken theirs, so an
unbounded quote is an unusably small place to type. Cutting at the last space
keeps the excerpt to whole words, and measuring in characters rather than bytes
keeps it from severing a codepoint in accented or CJK prose.

@param text the passage
@param limit characters to keep, defaulting to `View.EXCERPT_CHARS`
@treturn string
--]]
function View.excerpt(text, limit)
    if type(text) ~= "string" then return "" end
    limit = limit or View.EXCERPT_CHARS

    local offsets = char_offsets(text)
    if #offsets - 1 <= limit then return text end

    local head = text:sub(1, offsets[limit + 1] - 1)
    -- Back off to the last space, unless the whole excerpt is one long word, in
    -- which case the character boundary above is the best cut there is.
    local words = head:match("^(.*)%s")
    if words and words:match("%S") then head = words end
    return (head:gsub("%s+$", "")) .. "…"
end

--[[--
One thread as a transcript.

@param thread a stored thread (see marginalia_store.lua)
@treturn string
--]]
function View.transcript(thread)
    local lines = {}
    for _, message in ipairs(thread and thread.messages or {}) do
        -- Content goes in verbatim. A turn that is nothing but whitespace is
        -- dropped, but one that merely starts with some keeps it: a model that
        -- indented a block of code meant to.
        if type(message.content) == "string" and message.content:match("%S") then
            table.insert(lines, (PREFIX[message.role] or "") .. message.content)
        end
    end
    return table.concat(lines, "\n\n")
end

--- How many turns a thread holds, for a heading that says so.
function View.turn_count(thread)
    local count = 0
    for _, message in ipairs(thread and thread.messages or {}) do
        if type(message.content) == "string" and message.content:match("%S") then
            count = count + 1
        end
    end
    return count
end

--[[--
When a thread was last added to.

Ordering on this rather than on when it started: a conversation picked up again
this morning is the one the reader is most likely to be looking for, and burying
it under threads begun later but finished long ago is the opposite of useful.
--]]
function View.last_activity(thread)
    local latest = (thread and thread.created_at) or ""
    for _, message in ipairs(thread and thread.messages or {}) do
        local at = message.created_at
        if type(at) == "string" and at > latest then latest = at end
    end
    return latest
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

Ordered by last activity, newest first: the reason to open this is usually the
thing just asked, and scrolling back through an e-ink document to reach it is
the slowest possible way to find it. A thread begun weeks ago and picked up
again this morning therefore comes first, which is the point.

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
        local left = View.last_activity(a.thread)
        local right = View.last_activity(b.thread)
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
