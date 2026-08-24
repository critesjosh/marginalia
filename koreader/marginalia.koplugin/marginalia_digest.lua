--[[--
Bounds on the per-book digest.

A port of `src/lib/digest.ts`. Both ends of Marginalia keep a rolling summary of
what a reader and the model have worked out about a book, and both need the same
two guards on it, for the same two reasons.

**Echoed delimiters have to come off.** Summarisers routinely copy the fence
lines wrapping their input into their output. Because every update feeds the
stored digest back in to be fenced again, those markers stack up a pair per
round and never come off. They are inert — a fence from a past request cannot
close the fresh one wrapping it, which is the whole point of drawing a new token
each time — but they crowd out the notes they surround.

**There has to be a ceiling.** Nothing else bounds the digest: each update
replaces the previous one with whatever comes back, so a model that pads rather
than condenses ratchets upward with no step that ever shrinks it. The digest
rides in the system prompt of every question, so unbounded growth eventually
costs the reader their conversation, not just their notes.

No `require` of anything: this module is pure so it can be tested off-device.

@module marginalia.digest
--]]

local Digest = {}

--- Matches `FENCE_PREFIX` in src/lib/digest.ts.
Digest.FENCE_PREFIX = "BOOKDATA_"

--- Any token `Prompt.fence_token` can produce: the prefix and sixteen of [0-9A-Z].
local TOKEN = Digest.FENCE_PREFIX .. ("[%dA-Z]"):rep(16)

--[[--
Hard ceiling on a stored digest.

The summariser is asked for 250 words, which lands around 1,800 characters, so
this is roughly double what a well-behaved update produces and should never fire
on one.
--]]
Digest.MAX_SUMMARY_CHARS = 4000

--- Byte offset of the start of every UTF-8 character, plus an end sentinel.
local function char_offsets(s)
    local offsets = {}
    for position in s:gmatch("()[^\128-\191]") do
        offsets[#offsets + 1] = position
    end
    offsets[#offsets + 1] = #s + 1
    return offsets
end

--[[--
Removes delimiters a model copied out of its own prompt.

Whole lines go first. Blanking them in place would leave the empty line behind,
and a delimiter echoed mid-digest would then part the notes around it — invisible
while the markers sit at the very edges, as they usually do, but not once one
lands in the middle.
--]]
function Digest.strip_fence_tokens(text)
    if type(text) ~= "string" then return "" end

    local kept = {}
    -- `gmatch` on a pattern anchored to line ends misses a trailing line with no
    -- newline after it, so the text is split explicitly.
    local from = 1
    while from <= #text + 1 do
        local at = text:find("\n", from, true)
        local line = text:sub(from, (at or #text + 1) - 1)

        local without = line:gsub(TOKEN, "")
        -- A line that held a token and has nothing else on it is a fence line.
        if not (without ~= line and without:match("^%s*$")) then
            kept[#kept + 1] = without
        end

        if not at then break end
        from = at + 1
    end

    local out = table.concat(kept, "\n")
    -- Trailing blanks a stripped token left behind, then runs of empty lines.
    -- `\r` is in the class because a reply with CRLF endings would otherwise
    -- keep a carriage return on every line a token was taken off.
    out = out:gsub("[ \t\r]+\n", "\n")
    out = out:gsub("\n\n\n+", "\n\n")
    return (out:gsub("^%s+", ""):gsub("%s+$", ""))
end

--[[--
The latest structural boundary in `head`, past `minimum`.

Paragraph break, then line break, then sentence end, then word break — so a
clipped digest reads as notes rather than stopping mid-word. That matters beyond
tidiness: the result is fed back to the summariser as prior context, and a
severed clause invites it to invent the rest of the thought.

@param head the text being cut down
@param minimum byte offset the boundary must be past
@treturn number byte offset to cut after, or nil
--]]
local function last_boundary(head, minimum)
    local patterns = { "\n\n", "\n", "[.!?]", " " }
    for _, pattern in ipairs(patterns) do
        local best
        local from = 1
        while true do
            local at = head:find(pattern, from)
            if not at then break end
            best = at
            from = at + 1
        end
        if best and best > minimum then return best end
    end
    return nil
end

--[[--
What actually gets stored: no echoed delimiters, never over the ceiling.

Truncation is by character, not by byte. Slicing 4,000 bytes out of accented or
CJK prose severs a codepoint and leaves the digest ending in a broken character
— which is then fed back to the summariser as context.
--]]
function Digest.normalize_summary(text)
    local clean = Digest.strip_fence_tokens(text)

    local offsets = char_offsets(clean)
    local characters = #offsets - 1
    if characters <= Digest.MAX_SUMMARY_CHARS then return clean end

    local head = clean:sub(1, offsets[Digest.MAX_SUMMARY_CHARS + 1] - 1)
    -- Half the allowance, in characters. Taking half the *byte* length instead
    -- would put the threshold somewhere else entirely in prose that mixes ASCII
    -- with multibyte text, which is exactly the prose this ceiling fires on.
    local half = offsets[math.floor(Digest.MAX_SUMMARY_CHARS / 2) + 1] - 1
    local at = last_boundary(head, half)
    if at then
        return (head:sub(1, at):gsub("%s+$", "")) .. "…"
    end
    return (head:gsub("%s+$", "")) .. "…"
end

return Digest
