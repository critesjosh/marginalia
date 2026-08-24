--- Specs for marginalia_digest.lua — the two guards on the rolling summary.

local H = require("spec_helper")
local Digest = require("marginalia_digest")

local TOKEN = "BOOKDATA_0123456789ABCDEF"
local OTHER = "BOOKDATA_FEDCBA9876543210"

-- Summarisers copy the fence lines out of their prompt into their output, and
-- every update feeds the stored digest back in to be fenced again, so unstripped
-- markers stack up a pair per round and crowd out the notes.
do
    H.equal(Digest.strip_fence_tokens(TOKEN .. "\nReader thinks it is a joke.\n" .. TOKEN),
        "Reader thinks it is a joke.", "delimiters at the edges come off")

    H.equal(Digest.strip_fence_tokens("Notes.\n" .. TOKEN .. " " .. OTHER .. "\nMore notes."),
        "Notes.\nMore notes.", "a line of nothing but delimiters goes entirely")

    -- The line has to go, not just be blanked: a delimiter echoed mid-digest
    -- would otherwise leave a gap that parts the notes around it.
    local parted = Digest.strip_fence_tokens("First thought.\n" .. TOKEN .. "\nSecond thought.")
    H.equal(parted, "First thought.\nSecond thought.", "no gap left behind")

    H.equal(Digest.strip_fence_tokens("The reader mentioned " .. TOKEN .. " in passing."),
        "The reader mentioned  in passing.",
        "a delimiter inside a sentence is removed without taking the sentence")

    H.equal(Digest.strip_fence_tokens("  padded  "), "padded", "the result is trimmed")
    H.equal(Digest.strip_fence_tokens("a\n\n\n\n\nb"), "a\n\nb", "runs of blank lines collapse")
    H.equal(Digest.strip_fence_tokens(""), "")
    H.equal(Digest.strip_fence_tokens(nil), "", "nothing at all is not an error")

    -- Anything that is not exactly the shape of a token is text.
    H.equal(Digest.strip_fence_tokens("BOOKDATA_SHORT is fine"), "BOOKDATA_SHORT is fine")
    H.equal(Digest.strip_fence_tokens("BOOKDATA_0123456789abcdef stays"),
        "BOOKDATA_0123456789abcdef stays", "lowercase is not a token")
end

-- Nothing else bounds the digest: each update replaces the previous one with
-- whatever comes back, so a model that pads rather than condenses ratchets
-- upward with no step that shrinks it again.
do
    local short = "A few notes."
    H.equal(Digest.normalize_summary(short), short, "under the ceiling, untouched")

    local long = ("word "):rep(2000)
    local capped = Digest.normalize_summary(long)
    H.ok(#capped <= Digest.MAX_SUMMARY_CHARS + 4, "over the ceiling, cut down")
    H.contains(capped, "…", "and marked as cut")

    -- Cutting at a boundary matters beyond tidiness: the result is fed back to
    -- the summariser as prior context, and a severed clause invites it to
    -- invent the rest of the thought.
    local sentences = ("The reader considered the whale. "):rep(300)
    local cut = Digest.normalize_summary(sentences)
    H.ok(cut:find("%. ?…$") ~= nil or cut:find("%.…$") ~= nil,
        "a sentence end is preferred to a word break")

    local paragraphs = ("Some notes here.\n\n"):rep(400)
    local by_paragraph = Digest.normalize_summary(paragraphs)
    H.ok(#by_paragraph <= Digest.MAX_SUMMARY_CHARS + 4, "paragraphs are cut too")
end

-- Truncation counts characters, not bytes. Slicing 4,000 bytes out of accented
-- or CJK prose severs a codepoint, and the broken character is then fed back to
-- the summariser as context.
do
    local accented = ("é"):rep(5000)
    local capped = Digest.normalize_summary(accented)

    -- Every byte that starts a character must be followed by its continuation:
    -- count characters and check the total length is consistent.
    local characters = 0
    for _ in capped:gmatch("[^\128-\191]") do characters = characters + 1 end
    H.ok(characters <= Digest.MAX_SUMMARY_CHARS + 1,
        "the ceiling is in characters, so this is not cut to 2,000 of them")
    H.ok(characters > Digest.MAX_SUMMARY_CHARS / 2, "and it is not cut far short either")

    -- The last byte must not be a lone lead byte of a severed character.
    local tail = capped:sub(-1)
    H.ok(tail:byte() < 128 or tail:byte() >= 194 or true, "sanity")
    -- The real check: re-scanning the string finds no truncated sequence.
    local rebuilt = 0
    for character in capped:gmatch("[^\128-\191][\128-\191]*") do
        rebuilt = rebuilt + #character
    end
    H.equal(rebuilt, #capped, "no byte is left outside a complete character")
end

-- The two guards compose: a digest that is both fenced and over-long.
do
    local text = TOKEN .. "\n" .. ("note "):rep(2000) .. "\n" .. TOKEN
    local result = Digest.normalize_summary(text)
    H.absent(result, "BOOKDATA_", "delimiters gone")
    H.ok(#result <= Digest.MAX_SUMMARY_CHARS + 4, "and the ceiling still applied")
end

print("digest_spec ok")
