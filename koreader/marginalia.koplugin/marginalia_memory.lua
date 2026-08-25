--[[--
The rolling per-book digest.

What makes Marginalia more than a chat box: the model is told what you and it
have already worked out about this book, so a question asked in chapter thirty
can build on one asked in chapter three. A port of `src/lib/memory.ts`, with the
scheduling changed because an e-reader has nowhere to put background work.

**The browser folds a conversation right after it replies, and forgets about
it.** KOReader has one thread and a UI loop. There is no "afterwards" that is
not either making the reader wait a second time for one question, or being
cancelled by their next tap. So the fold happens *lazily, immediately before the
digest is needed* — at the start of the next question in that thread, where the
reader is already waiting for a model and where the freshened digest goes
straight into the prompt being built. A thread never returned to is folded only
by **Update notes now**, which is the honest price of not working while somebody
is reading.

**Only the thread in hand is folded**, which is what the browser does too:
`updateBookMemory(bookId, conversationId)` only ever folds the conversation it
was handed.

The pure half — deciding whether there is anything to fold, and which turns fit
— is separated from the half that talks to the relay and writes the sidecar, so
the arithmetic that decides what the model sees can be tested off-device.

@module marginalia.memory
--]]

local Trapper = require("ui/trapper")
local logger = require("logger")
local _ = require("gettext")

local Digest = require("marginalia_digest")
local Prompt = require("marginalia_prompt")
local Relay = require("marginalia_relay")
local Store = require("marginalia_store")
local Util = require("marginalia_util")

local Memory = {}

--- Fold a thread into the digest once it has this many unfolded turns.
Memory.MESSAGES_PER_UPDATE = 4

--[[--
Ceiling on the transcript handed to the summariser in one update.

`summarized_count` only advances when an update completes, and every failure is
swallowed, so without this the turns waiting to be folded grow by two per reply
for as long as the summariser is down. That is not merely wasteful: once the
backlog passes what the relay accepts, the request fails *on size*, and since
the backlog only ever grows it can never succeed again. The digest for that
thread would be dead from then on, silently.

Counted in bytes rather than characters — a deliberate difference from the
browser, which counts UTF-16 units. Bytes are the conservative direction: for
non-ASCII prose this sends less than the browser would, never more.
--]]
Memory.MAX_TRANSCRIPT_BYTES = 24000

function Memory:new(o)
    o = o or {}
    setmetatable(o, self)
    self.__index = self
    return o
end

--- How many of a thread's turns have not been folded in yet.
function Memory.pending_count(thread)
    local messages = (thread and thread.messages) or {}
    return #messages - (thread.summarized_count or 0)
end

--- Whether this thread has accumulated enough to be worth an update.
function Memory.is_due(thread)
    return Memory.pending_count(thread) >= Memory.MESSAGES_PER_UPDATE
end

--[[--
The newest unfolded turns that fit the budget.

Walks back from the latest turn, so what survives a backlog is the part of the
conversation closest to where the reader actually is. Turns older than the
window are dropped rather than deferred: the counter jumps past them on success
and they are never folded in. That loses the oldest few exchanges after an
outage, which beats a summariser that can never run again.

The newest `MESSAGES_PER_UPDATE` turns go out even when they exceed the budget
on their own, so an update always carries something. A single enormous turn can
still overrun, but it falls out of that window within an exchange or two, so the
failure clears itself.

@treturn table array of messages
--]]
function Memory.window(thread)
    local messages = (thread and thread.messages) or {}
    local first_pending = (thread.summarized_count or 0) + 1

    local bytes = 0
    local start = #messages + 1
    while start > first_pending do
        local content = messages[start - 1].content or ""
        if bytes + #content > Memory.MAX_TRANSCRIPT_BYTES then break end
        bytes = bytes + #content
        start = start - 1
    end

    -- Never fewer than the newest few, whatever they weigh.
    local floor = math.max(first_pending, #messages - Memory.MESSAGES_PER_UPDATE + 1)
    if start > floor then start = floor end

    local window = {}
    for index = start, #messages do
        window[#window + 1] = messages[index]
    end
    return window
end

--- The transcript as the summariser sees it.
function Memory.transcript(messages)
    local lines = {}
    for _, message in ipairs(messages or {}) do
        local who = message.role == "user" and "Reader" or "Companion"
        lines[#lines + 1] = who .. ": " .. (message.content or "")
    end
    return table.concat(lines, "\n\n")
end

--[[--
Folds one thread's pending turns into the book's digest.

Must be called inside a `Trapper:wrap`. Blocking work goes to a subprocess, and
the reader can dismiss it — dismissing leaves the digest as it was and the
counter untouched, so the same turns are folded on the next attempt.

Reads and writes the sidecar itself. Callers must therefore re-read the store
afterwards rather than holding a copy across this call: everything lives under
one `marginalia` key, and a stale whole-table write puts the old digest back.

@param thread_id which thread to fold
@param minimum how many pending turns are needed, default `MESSAGES_PER_UPDATE`.
  The manual sweep passes 1: a conversation asked once and left has two turns,
  and waiting for a fourth that is never coming would keep it out of the notes
  for good.
@treturn boolean whether the digest was updated
@treturn string a reason, when it was not
--]]
function Memory:fold(thread_id, minimum)
    local data = Store.read(self.ui.doc_settings)

    local thread
    for _, candidate in ipairs(data.threads or {}) do
        if candidate.id == thread_id then thread = candidate break end
    end
    if not thread then return false, "no such conversation" end
    if Memory.pending_count(thread) < (minimum or Memory.MESSAGES_PER_UPDATE) then
        return false, "nothing new to fold in"
    end

    local window = Memory.window(thread)
    local transcript = Memory.transcript(window)
    -- Captured before the request: the counter advances to what was there when
    -- the model was asked, not to what fitted the budget. Turns older than the
    -- window are discarded deliberately, which is what stops a backlog from
    -- growing without bound.
    local snapshot_count = #thread.messages

    local existing = data.memory and data.memory.summary
    local book = self:book_metadata()

    local fence, fence_error = Prompt.fence_for(
        { transcript, existing, book.title, book.authors }, Util.random_hex)
    if not fence then return false, fence_error end

    local messages = Prompt.summary_messages{
        book = book,
        existing = existing,
        transcript = transcript,
        fence = fence,
    }

    local settings = self.settings
    local cafile = self.cafile
    local version = self.plugin_version

    local completed, result = Trapper:dismissableRunInSubprocess(function()
        return Relay.ask(settings, messages, cafile, version)
    end, _("Catching up on your notes…"))

    if not completed then return false, "cancelled" end
    if type(result) ~= "table" or not result.ok then
        local reason = type(result) == "table" and result.error or "the summary failed"
        logger.warn("marginalia: digest update failed:", reason)
        return false, reason
    end

    -- A reply that is nothing but echoed delimiters normalises to empty, and
    -- storing that would wipe notes the reader may have written by hand.
    local summary = Digest.normalize_summary(result.text)
    if summary == "" then return false, "the summary came back empty" end

    -- Re-read: the fold above went out to the network, and nothing guarantees
    -- the table read at the top is still what is stored.
    data = Store.read(self.ui.doc_settings)
    for _, candidate in ipairs(data.threads or {}) do
        if candidate.id == thread_id then
            candidate.summarized_count = snapshot_count
            break
        end
    end

    -- One step of undo. A bad update feeds itself into every later one, and a
    -- reader on an e-reader is far less likely to notice that happening than
    -- one looking at a memory panel in a browser.
    local previous = data.memory and data.memory.summary
    data.memory = {
        summary = summary,
        updated_at = Util.now_local(),
        previous = previous,
    }
    Store.write(self.ui.doc_settings, data)

    return true
end

--[[--
Folds every conversation with anything unfolded in it. For the manual action.

The threshold here is one turn, not four. The automatic path waits for four
because it is spending the reader's time on a question they are already waiting
for; this path was asked for, and its whole purpose is to catch up the
conversations the automatic path cannot reach — which are exactly the short ones
that were asked about once and left alone.

@treturn number how many conversations were folded
@treturn number how many were attempted and failed
@treturn string the last failure, if there was one
--]]
function Memory:fold_all()
    local data = Store.read(self.ui.doc_settings)

    local pending = {}
    for _, thread in ipairs(data.threads or {}) do
        if Memory.pending_count(thread) > 0 then pending[#pending + 1] = thread.id end
    end
    if #pending == 0 then return 0, 0, "nothing new to fold in" end

    local folded, failed = 0, 0
    local last_reason
    for _, id in ipairs(pending) do
        local ok, reason = self:fold(id, 1)
        if ok then
            folded = folded + 1
        else
            failed = failed + 1
            last_reason = reason
            -- A cancelled fold means the reader wants out of this altogether,
            -- not just out of this one conversation.
            if reason == "cancelled" then break end
        end
    end
    return folded, failed, last_reason
end

--- Whether there is a previous digest to put back.
function Memory:has_undo()
    local data = Store.read(self.ui.doc_settings)
    return (data.memory and data.memory.previous) ~= nil
end

--- The book's digest as it stands, or nil.
function Memory:current()
    local data = Store.read(self.ui.doc_settings)
    return data.memory
end

--- Replaces the digest with the reader's own wording. Empty clears it.
function Memory:save(summary)
    local data = Store.read(self.ui.doc_settings)
    local normalized = Digest.normalize_summary(summary or "")
    local previous = data.memory and data.memory.summary

    if normalized == "" then
        data.memory = previous and { previous = previous, updated_at = Util.now_local() } or nil
    else
        data.memory = {
            summary = normalized,
            updated_at = Util.now_local(),
            previous = previous,
        }
    end
    Store.write(self.ui.doc_settings, data)
end

--- Puts back the digest the last update replaced.
function Memory:undo()
    local data = Store.read(self.ui.doc_settings)
    local previous = data.memory and data.memory.previous
    if not previous then return false end

    data.memory = {
        summary = previous,
        updated_at = Util.now_local(),
    }
    Store.write(self.ui.doc_settings, data)
    return true
end

function Memory:book_metadata()
    local props = self.ui.doc_props or {}
    return {
        title = props.display_title or props.title,
        authors = props.authors,
    }
end

return Memory
