--- Specs for marginalia_view.lua — how a saved conversation reads back.

local H = require("spec_helper")
local View = require("marginalia_view")

--- Marks a field the case wants *absent*: `pairs` skips a nil value, so an
--- override table cannot express "unset this" on its own.
local NONE = setmetatable({}, { __tostring = function() return "NONE" end })

local function thread(overrides)
    local t = {
        id = "koreader:t1",
        title = "Father Mapple rose",
        chapter = "CHAPTER 9. The Sermon.",
        progress = 0.089,
        created_at = "2026-08-23 19:39:50",
        messages = {
            { id = "koreader:m1", role = "user", content = "Why a ship's prow?" },
            { id = "koreader:m2", role = "assistant", content = "It makes him go first." },
        },
    }
    for key, value in pairs(overrides or {}) do
        t[key] = value ~= NONE and value or nil
    end
    return t
end

-- The transcript is what the on-screen view shows *and* what Save to note
-- writes, which is the whole reason it is one function.
do
    H.equal(View.transcript(thread()),
        "Q: Why a ship's prow?\n\nA: It makes him go first.", "both turns, marked and spaced")

    H.equal(View.transcript(thread({ messages = {} })), "", "no turns, nothing to show")
    H.equal(View.transcript(nil), "", "no thread at all is not an error")

    H.equal(View.transcript(thread({ messages = {
        { role = "user", content = "  padded  " },
        { role = "assistant", content = "   " },
    } })), "Q: padded", "blank turns are dropped and the rest is trimmed")

    H.equal(View.turn_count(thread()), 2)
    H.equal(View.turn_count(thread({ messages = {
        { role = "user", content = "one" },
        { role = "assistant", content = "" },
    } })), 1, "a blank turn is not a turn")
end

-- Where in the book, and when.
do
    H.equal(View.heading(thread()), "CHAPTER 9. The Sermon. · 9% · 2026-08-23 19:39:50")
    H.equal(View.heading(thread({ chapter = NONE })), "9% · 2026-08-23 19:39:50",
        "a book with no table of contents still gets a heading")
    H.equal(View.heading(thread({ chapter = NONE, progress = NONE })), "2026-08-23 19:39:50")
    H.equal(View.heading({}), "", "nothing known, nothing claimed")
end

do
    local document = View.thread_document(thread())
    H.contains(document, "CHAPTER 9. The Sermon.", "heading first")
    H.contains(document, "Q: Why a ship's prow?", "then the exchange")
    -- The passage is not repeated above the conversation: on a six-inch screen
    -- a quoted paragraph over every thread is most of the screen.
    H.absent(document, "Father Mapple rose", "the title is the viewer's, not the body's")

    H.equal(View.thread_document(thread({ messages = {} })), View.heading(thread()),
        "a thread with nothing said is just its heading")
end

-- The book-wide scroll: newest first, because the reason to open it is usually
-- the thing just asked.
do
    local first = thread({ id = "a", title = "Asked first", created_at = "2026-08-20 10:00:00",
        messages = { { role = "user", content = "earliest question" } } })
    local last = thread({ id = "b", title = "Asked last", created_at = "2026-08-23 19:39:50",
        messages = { { role = "user", content = "newest question" } } })

    local document = View.book_document({ first, last })
    H.ok(document:find("newest question", 1, true) < document:find("earliest question", 1, true),
        "the most recent conversation comes first")
    H.contains(document, "Asked first", "and the older one is still there")
    H.contains(document, "─", "with a rule between them")

    -- Sorting must not reorder the sidecar's own table, which is what the next
    -- export writes out.
    local threads = { first, last }
    View.book_document(threads)
    H.equal(threads[1].id, "a", "the stored order is left alone")
    H.equal(threads[2].id, "b")
end

do
    H.equal(View.book_document({}, "Nothing yet."), "Nothing yet.", "empty says so")
    H.equal(View.book_document(nil, "Nothing yet."), "Nothing yet.")
    -- In the book-wide scroll each block carries its own title, because there
    -- is no per-thread title bar to put it in the way there is for one thread.
    H.equal(View.book_document({ thread({ messages = {} }) }, "Nothing yet."),
        "Father Mapple rose\n\n" .. View.heading(thread()),
        "a thread with nothing said is still listed, titled and placed")
end

-- Two threads made in the same second must not depend on the sort algorithm to
-- decide which comes out first.
do
    local a = thread({ id = "a", title = "First stored", created_at = "2026-08-23 19:39:50",
        messages = { { role = "user", content = "alpha" } } })
    local b = thread({ id = "b", title = "Second stored", created_at = "2026-08-23 19:39:50",
        messages = { { role = "user", content = "beta" } } })

    local document = View.book_document({ a, b })
    H.ok(document:find("beta", 1, true) < document:find("alpha", 1, true),
        "a tie keeps the later-stored thread first, stably")
end

print("view_spec ok")
