--- Specs for marginalia_payload.lua — the handoff document and its identities.

local H = require("spec_helper")
local Payload = require("marginalia_payload")

--- A stand-in digest: not SHA-256, but injective enough to test identity with,
--- and deterministic so a spec can state exact expectations. Hex is assembled by
--- hand rather than with `%x`, whose integer requirement differs between Lua
--- implementations and has nothing to do with what is under test.
local HEX = "0123456789abcdef"

local function hex8(value)
    local out = {}
    for i = 8, 1, -1 do
        local nibble = value % 16
        out[i] = HEX:sub(nibble + 1, nibble + 1)
        value = (value - nibble) / 16
    end
    return table.concat(out)
end

local function fake_sha256(text)
    local hash = 5381
    for i = 1, #text do
        hash = (hash * 33 + text:byte(i)) % 4294967296
    end
    return hex8(hash):rep(4)
end

-- The real annotation KOReader wrote on the test device.
local ANNOTATION = {
    chapter = "INTRODUCTION",
    color = "gray",
    datetime = "2026-08-23 19:39:35",
    datetime_updated = "2026-08-23 19:39:56",
    drawer = "lighten",
    note = "this is the first test note",
    page = "/body/DocFragment[3]/body/p[1]/text()[3].38",
    pageno = 13,
    pos0 = "/body/DocFragment[3]/body/p[1]/text()[3].38",
    pos1 = "/body/DocFragment[3]/body/p[1]/text()[4].92",
    text = "short chapter he devotes to Twilight",
}

local function build(overrides)
    local spec = {
        book = {
            title = "Twilight of Idols and Anti-Christ",
            authors = "Friedrich Nietzsche",
            language = "en",
            pages = 351,
            file = {
                name = "Twilight of Idols and Anti-Christ.epub",
                size = 1234567,
                sha256 = "abc123",
                partial_md5 = "1ae1faef4cb68f7e8f7a545def7995e8",
            },
        },
        annotations = { ANNOTATION },
        contexts = {},
        threads = {},
        exported_at = "2026-08-23 20:00:00",
        tz_offset = "-0500",
        app_version = "v2026.07.1",
        plugin_version = "1.0.0",
        sha256_hex = fake_sha256,
    }
    for key, value in pairs(overrides or {}) do spec[key] = value end
    return Payload.build(spec)
end

-- A sidecar datetime is device-local with no offset. Reading one in a browser
-- somewhere else would move it silently, so the device resolves it here.
do
    H.equal(Payload.to_iso("2026-08-23 19:39:35", "-0500"), "2026-08-23T19:39:35-05:00", "negative offset")
    H.equal(Payload.to_iso("2026-08-23 19:39:35", "+0530"), "2026-08-23T19:39:35+05:30", "half-hour offset")
    H.equal(Payload.to_iso("2026-08-23 19:39:35", nil), "2026-08-23T19:39:35Z", "no offset falls back to Z")
    H.equal(Payload.to_iso("2026-08-23 19:39:35", "Eastern Standard Time"), "2026-08-23T19:39:35Z",
        "a non-numeric offset is not smuggled into the timestamp")
    H.nil_(Payload.to_iso("not a date", "-0500"), "unparseable input yields nothing")
    H.nil_(Payload.to_iso(nil, "-0500"), "missing input yields nothing")
end

-- KOReader has nine highlight colours and Marginalia has four. Every one has to
-- land somewhere valid, and `gray` — KOReader's default — must not fall through.
do
    H.equal(Payload.color("gray"), "yellow", "the default colour lands on yellow")
    H.equal(Payload.color("yellow"), "yellow")
    H.equal(Payload.color("olive"), "green", "olive is a green")
    H.equal(Payload.color("cyan"), "blue", "cyan is a blue")
    H.equal(Payload.color("purple"), "pink")
    H.equal(Payload.color("red"), "pink")
    H.equal(Payload.color(nil), "yellow", "a colourless highlight still gets a valid colour")
    H.equal(Payload.color("chartreuse"), "yellow", "an unknown colour does not escape the palette")
end

-- Identity is content-derived, so exporting twice is not two different books'
-- worth of highlights.
do
    local first = Payload.external_id(ANNOTATION, fake_sha256)
    local again = Payload.external_id(ANNOTATION, fake_sha256)
    H.equal(first, again, "the same annotation always gets the same id")
    H.contains(first, "koreader:", "ids are namespaced so they cannot collide with the app's own")
    H.equal(#first, #"koreader:" + 16, "sixteen hex characters")

    local moved = {}
    for k, v in pairs(ANNOTATION) do moved[k] = v end
    moved.pos0 = "/body/DocFragment[3]/body/p[9]/text()[1].0"
    H.ok(Payload.external_id(moved, fake_sha256) ~= first, "a different position is a different highlight")

    local reworded = {}
    for k, v in pairs(ANNOTATION) do reworded[k] = v end
    reworded.text = "something else entirely"
    H.ok(Payload.external_id(reworded, fake_sha256) ~= first, "different text is a different highlight")

    local later = {}
    for k, v in pairs(ANNOTATION) do later[k] = v end
    later.datetime = "2026-08-24 08:00:00"
    H.ok(Payload.external_id(later, fake_sha256) ~= first,
        "re-highlighting the same words later is a different highlight")
end

-- The document itself.
do
    local document = build()

    H.equal(document.format, "marginalia-koreader", "format tag")
    H.equal(document.version, 1, "version")
    H.equal(document.exportedAt, "2026-08-23T20:00:00-05:00", "export time carries its offset")
    H.equal(document.exportedAtLocal, "2026-08-23 20:00:00", "and the verbatim device string travels too")
    H.equal(document.source.app, "koreader")
    H.equal(document.source.appVersion, "v2026.07.1")
    H.equal(document.book.file.sha256, "abc123", "the hash the app matches editions on")
    H.equal(document.book.file.partialMd5, "1ae1faef4cb68f7e8f7a545def7995e8", "KOReader's own identity travels")

    local highlight = document.book.highlights[1]
    H.equal(#document.book.highlights, 1, "one highlight")
    H.equal(highlight.text, ANNOTATION.text)
    H.equal(highlight.note, "this is the first test note")
    H.equal(highlight.chapter, "INTRODUCTION")
    H.equal(highlight.color, "yellow", "mapped out of KOReader's palette")
    H.equal(highlight.createdAt, "2026-08-23T19:39:35-05:00")
    H.equal(highlight.createdAtLocal, "2026-08-23 19:39:35")
    H.equal(highlight.pageno, 13)
    H.ok(math.abs(highlight.progress - 13 / 351) < 1e-9, "progress is pages, for display only")
    H.equal(highlight.anchor.engine, "crengine")
    H.equal(highlight.anchor.start, ANNOTATION.pos0, "the xpointer rides along as provenance")
    H.equal(highlight.anchor["end"], ANNOTATION.pos1)
end

-- A page bookmark has no highlighted text and is not a highlight.
do
    local document = build({ annotations = {
        ANNOTATION,
        { datetime = "2026-08-23 19:00:00", page = "/body/DocFragment[2]/body/p[1]" },
        { datetime = "2026-08-23 19:00:00", text = "   ", page = "/body/DocFragment[2]/body/p[2]" },
    } })
    H.equal(#document.book.highlights, 1, "bookmarks and blank highlights are left out")
end

-- Missing page counts must not produce a progress of nil-divided-by-nothing.
do
    local document = build({ book = {
        title = "Untitled", authors = "Unknown", file = {},
    } })
    H.nil_(document.book.highlights[1].progress, "no page count, no progress")
    H.nil_(document.book.pages, "and no invented page count")
end

-- Context is looked up by the same id the highlight is exported under.
do
    local id = Payload.external_id(ANNOTATION, fake_sha256)
    local document = build({ contexts = { [id] = "  prose around the passage  " } })
    H.equal(document.book.highlights[1].context, "prose around the passage", "trimmed, and attached")
end

-- Threads carry their own ids so a re-import can tell what it has already seen.
do
    local document = build({ threads = { {
        id = "koreader:thread-1",
        highlight_ref = Payload.external_id(ANNOTATION, fake_sha256),
        title = "short chapter he devotes to Twilight",
        seed_text = ANNOTATION.text,
        chapter = "INTRODUCTION",
        created_at = "2026-08-23 19:40:00",
        messages = {
            { id = "koreader:m1", role = "user", content = "What is he getting at?",
              created_at = "2026-08-23 19:40:00" },
            { id = "koreader:m2", role = "assistant", content = "He is describing…",
              created_at = "2026-08-23 19:40:12" },
        },
    }, {
        id = "koreader:thread-empty",
        created_at = "2026-08-23 19:41:00",
        messages = {},
    } } })

    H.equal(#document.book.threads, 1, "a thread with no messages is not worth exporting")

    local thread = document.book.threads[1]
    H.equal(thread.externalId, "koreader:thread-1")
    H.equal(thread.highlightExternalId, Payload.external_id(ANNOTATION, fake_sha256), "linked to its highlight")
    H.equal(thread.seedText, ANNOTATION.text, "the passage travels with the thread")
    H.equal(thread.createdAt, "2026-08-23T19:40:00-05:00")
    H.equal(#thread.messages, 2)
    H.equal(thread.messages[1].externalId, "koreader:m1", "message identity is minted on the device")
    H.equal(thread.messages[1].role, "user")
    H.equal(thread.messages[2].createdAt, "2026-08-23T19:40:12-05:00")
end

print("payload_spec ok")
