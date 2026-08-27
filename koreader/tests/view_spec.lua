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

    -- Content is verbatim: a model that indented a block of code meant to, and
    -- a note written from this is the reader's record of what was actually said.
    -- Only a turn that is nothing but whitespace is dropped.
    H.equal(View.transcript(thread({ messages = {
        { role = "user", content = "  padded  " },
        { role = "assistant", content = "   " },
    } })), "Q:   padded  ", "a wholly blank turn goes; spacing inside one stays")

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

-- Last activity, not creation time: a thread picked up again this morning is
-- what the reader is looking for, even if it was started weeks ago.
do
    local old_thread = thread({ id = "old", created_at = "2026-08-01 09:00:00",
        messages = {
            { role = "user", content = "asked long ago", created_at = "2026-08-01 09:00:00" },
            { role = "user", content = "picked up today", created_at = "2026-08-23 20:00:00" },
        } })
    local newer = thread({ id = "newer", created_at = "2026-08-10 09:00:00",
        messages = { { role = "user", content = "begun later, finished then",
                       created_at = "2026-08-10 09:00:00" } } })

    H.equal(View.last_activity(old_thread), "2026-08-23 20:00:00", "the latest turn wins")
    H.equal(View.last_activity(newer), "2026-08-10 09:00:00")
    H.equal(View.last_activity(thread({ messages = {} })), "2026-08-23 19:39:50",
        "a thread with no turns falls back to when it started")

    local document = View.book_document({ old_thread, newer })
    H.ok(document:find("picked up today", 1, true) < document:find("begun later", 1, true),
        "the thread added to most recently comes first")
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

-- The passage quoted above the question box. What matters is that an ordinary
-- highlight is shown whole and a page-long one is not, since the box below it
-- is sized from what the quote leaves behind.
do
    local short = "One must be superior to mankind in force."
    H.equal(View.excerpt(short), short, "a sentence is quoted whole")
    H.equal(View.excerpt(""), "", "nothing quotes as nothing")
    H.equal(View.excerpt(nil), "", "no passage at all is not an error")

    local long = ("word "):rep(200)
    local cut = View.excerpt(long)
    H.ok(#cut < #long, "a page-long passage is shortened")
    H.equal(cut:sub(-4), "d…", "it ends on a whole word, with the ellipsis against it")

    H.equal(View.excerpt("alpha beta gamma", 12), "alpha beta…",
        "the last whole word inside the limit, with the space trimmed")

    -- Measured in characters, not bytes: an accented passage must not be cut to
    -- a third of its apparent length, nor severed mid-codepoint.
    local accented = ("é"):rep(40)
    H.equal(View.excerpt(accented, 40), accented, "40 characters is 40 characters")
    H.equal(View.excerpt(accented, 20), ("é"):rep(20) .. "…",
        "an unbroken run of multibyte characters cuts on a codepoint boundary")
end

print("view_spec ok")
