--- Specs for the arithmetic in marginalia_memory.lua: what gets folded, and
--- which turns the summariser is actually shown.

local H = require("spec_helper")
local Memory = require("marginalia_memory")

local function turns(count, size)
    local messages = {}
    for index = 1, count do
        messages[index] = {
            role = index % 2 == 1 and "user" or "assistant",
            content = string.rep("x", size or 10) .. index,
        }
    end
    return messages
end

-- Whether there is anything worth an update.
do
    H.equal(Memory.pending_count({ messages = turns(6), summarized_count = 4 }), 2)
    H.equal(Memory.pending_count({ messages = turns(3) }), 3, "no counter means none folded")
    H.equal(Memory.pending_count({ messages = {} }), 0)

    H.ok(not Memory.is_due({ messages = turns(3) }), "three turns is not yet an update")
    H.ok(Memory.is_due({ messages = turns(4) }), "four is")
    H.ok(not Memory.is_due({ messages = turns(6), summarized_count = 4 }),
        "and four already folded leaves two, which is not")
    H.ok(Memory.is_due({ messages = turns(8), summarized_count = 4 }))
end

-- Only unfolded turns are sent, and they are the newest ones.
do
    local thread = { messages = turns(10), summarized_count = 6 }
    local window = Memory.window(thread)
    H.equal(#window, 4, "the four that have not been folded")
    H.equal(window[1].content, string.rep("x", 10) .. "7", "starting after the counter")
    H.equal(window[4].content, string.rep("x", 10) .. "10")
end

-- A backlog is bounded. Without this, a summariser that is down accumulates
-- turns until the request fails on size — and since the backlog only grows, it
-- can then never succeed again, killing the digest silently.
do
    local big = math.floor(Memory.MAX_TRANSCRIPT_BYTES / 4)
    local thread = { messages = turns(20, big) }
    local window = Memory.window(thread)

    local bytes = 0
    for _, message in ipairs(window) do bytes = bytes + #message.content end
    H.ok(bytes <= Memory.MAX_TRANSCRIPT_BYTES + big,
        "the window is bounded rather than sending the whole backlog")
    H.ok(#window < 20, "so older turns are left out")
    H.equal(window[#window].content, thread.messages[20].content,
        "and what survives is the end of the conversation, nearest where the reader is")
end

-- An update always carries something, even when the newest turns alone are
-- over budget. A single enormous turn falls out of that window within an
-- exchange or two, so the failure clears itself.
do
    local huge = Memory.MAX_TRANSCRIPT_BYTES * 2
    local thread = { messages = turns(6, huge) }
    local window = Memory.window(thread)
    H.equal(#window, Memory.MESSAGES_PER_UPDATE,
        "never fewer than the newest few, whatever they weigh")
    H.equal(window[#window].content, thread.messages[6].content)
end

-- The floor never reaches back past the counter into turns already folded.
do
    local huge = Memory.MAX_TRANSCRIPT_BYTES * 2
    local thread = { messages = turns(6, huge), summarized_count = 4 }
    local window = Memory.window(thread)
    H.equal(#window, 2, "only the two unfolded turns, despite the floor of four")
    H.equal(window[1].content, thread.messages[5].content)
end

-- The automatic path waits for four turns because it is spending time the
-- reader is already giving to a question. The manual sweep has no such excuse
-- and must not inherit the threshold: a conversation asked about once and left
-- alone has two turns, and waiting for a fourth that is never coming would keep
-- it out of the notes for good.
do
    local one_exchange = { messages = turns(2) }
    H.ok(not Memory.is_due(one_exchange), "not due automatically")
    H.equal(Memory.pending_count(one_exchange), 2, "but it does have something to fold")

    local window = Memory.window(one_exchange)
    H.equal(#window, 2, "and the window offers both turns")
end

-- What the summariser reads.
do
    local transcript = Memory.transcript({
        { role = "user", content = "Why a ship's prow?" },
        { role = "assistant", content = "It makes him go first." },
    })
    H.equal(transcript, "Reader: Why a ship's prow?\n\nCompanion: It makes him go first.",
        "the roles are named as the web app names them")

    H.equal(Memory.transcript({}), "")
    H.equal(Memory.transcript(nil), "")
end

print("memory_spec ok")
