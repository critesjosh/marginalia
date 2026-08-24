--[[--
Builds the handoff document the Marginalia web reader imports.

The shape is `format: "marginalia-koreader"`, version 1. Two things about it are
load-bearing and worth stating here rather than discovering later.

**Identity is content-derived.** A highlight's `externalId` is a hash of where it
starts, when it was made and what it says, so exporting the same book twice
produces the same ids and a second import is a genuine no-op. KOReader has no id
of its own to borrow.

**Timestamps carry their offset.** A sidecar datetime is device-local with no
zone (`2026-08-23 19:39:35`), so reading one in a browser somewhere else would
silently move it by hours. The device knows its own offset, so it resolves the
ambiguity here rather than exporting a question. The verbatim string travels too,
under `createdAtLocal`, because that is what KOReader itself shows.

The crengine xpointers ride along under `anchor` as provenance. Nothing in the
web app reads them — an xpointer and an epub.js CFI are different coordinate
systems — but they are the only record of where a highlight sat in *this*
engine, and throwing them away would make a future KOReader-direction sync
impossible to build.

No `require` of anything: this module is pure so it can be tested off-device.

@module marginalia.payload
--]]

local Payload = {}

Payload.FORMAT = "marginalia-koreader"
Payload.VERSION = 1

--[[--
KOReader offers nine highlight colours; Marginalia has four.

`gray` is KOReader's default drawer colour, so it is much the most common value
and has to land somewhere sensible rather than on whatever sorts first.
--]]
local COLORS = {
    red     = "pink",
    orange  = "pink",
    purple  = "pink",
    yellow  = "yellow",
    gray    = "yellow",
    green   = "green",
    olive   = "green",
    blue    = "blue",
    cyan    = "blue",
}

function Payload.color(koreader_color)
    return COLORS[koreader_color or ""] or "yellow"
end

--[[--
Turns a sidecar datetime into ISO 8601 with an explicit offset.

@param datetime string "YYYY-MM-DD HH:MM:SS", device-local
@param tz_offset string "+HHMM" or "-HHMM", from `os.date("%z")`
@treturn string or nil if the datetime is not in the expected shape
--]]
function Payload.to_iso(datetime, tz_offset)
    if type(datetime) ~= "string" then return nil end
    local date, time = datetime:match("^(%d%d%d%d%-%d%d%-%d%d)[ T](%d%d:%d%d:%d%d)")
    if not date then return nil end

    local sign, hours, minutes = (tz_offset or ""):match("^([+%-])(%d%d)(%d%d)$")
    local zone = sign and (sign .. hours .. ":" .. minutes) or "Z"
    return date .. "T" .. time .. zone
end

--- A page bookmark has no highlighted text; only real highlights are exported.
local function is_highlight(annotation)
    return type(annotation.text) == "string" and annotation.text:match("%S") ~= nil
end

local function trimmed(value)
    if type(value) ~= "string" then return nil end
    local clean = value:gsub("^%s+", ""):gsub("%s+$", "")
    if clean == "" then return nil end
    return clean
end

--[[--
The stable external id for one annotation.

Start position, creation time and text together: position alone collides when a
book is re-highlighted at the same spot, and text alone collides on a repeated
sentence. Sixteen hex characters is 64 bits, which is far more than enough for
the few hundred highlights one book collects.
--]]
function Payload.external_id(annotation, sha256_hex)
    local parts = table.concat({
        annotation.pos0 or annotation.page or "",
        annotation.datetime or "",
        annotation.text or "",
    }, "\0")
    return "koreader:" .. sha256_hex(parts):sub(1, 16)
end

--[[--
Builds the document.

@param spec table with:
    book        { title, authors, language, publisher, published, pages,
                  file = { name, size, sha256, partial_md5 } }
    annotations array of KOReader annotation records
    contexts    table of externalId -> surrounding prose, or nil
    threads     array of stored threads (see store.lua), or nil
    exported_at string device-local "YYYY-MM-DD HH:MM:SS"
    tz_offset   string from `os.date("%z")`
    app_version string KOReader's version
    plugin_version string
    sha256_hex  function(string) -> lowercase hex digest
@treturn table ready to be JSON-encoded
--]]
function Payload.build(spec)
    local sha256_hex = spec.sha256_hex
    local tz = spec.tz_offset
    local book = spec.book or {}
    local pages = tonumber(book.pages)

    local contexts = spec.contexts or {}
    local highlights = {}
    for _, annotation in ipairs(spec.annotations or {}) do
        if is_highlight(annotation) then
            local pageno = tonumber(annotation.pageno)
            local external_id = Payload.external_id(annotation, sha256_hex)
            table.insert(highlights, {
                externalId     = external_id,
                text           = annotation.text,
                note           = trimmed(annotation.note),
                chapter        = trimmed(annotation.chapter),
                color          = Payload.color(annotation.color),
                createdAt      = Payload.to_iso(annotation.datetime, tz),
                createdAtLocal = annotation.datetime,
                pageno         = pageno,
                -- Cosmetic only. KOReader pages depend on font size and margins,
                -- so this is not comparable with the app's own progress and must
                -- never be used to decide *where* a highlight goes.
                progress       = (pageno and pages and pages > 0)
                                 and (pageno / pages) or nil,
                context        = trimmed(contexts[external_id]),
                anchor         = {
                    engine = "crengine",
                    start  = annotation.pos0,
                    ["end"] = annotation.pos1,
                },
            })
        end
    end

    local threads = {}
    for _, thread in ipairs(spec.threads or {}) do
        local messages = {}
        for _, message in ipairs(thread.messages or {}) do
            table.insert(messages, {
                externalId     = message.id,
                role           = message.role,
                content        = message.content,
                createdAt      = Payload.to_iso(message.created_at, tz),
                createdAtLocal = message.created_at,
            })
        end
        if #messages > 0 then
            table.insert(threads, {
                externalId          = thread.id,
                highlightExternalId = thread.highlight_ref,
                title               = thread.title,
                seedText            = thread.seed_text,
                context             = thread.context,
                chapter             = thread.chapter,
                progress            = thread.progress,
                createdAt           = Payload.to_iso(thread.created_at, tz),
                createdAtLocal      = thread.created_at,
                messages            = messages,
            })
        end
    end

    return {
        format = Payload.FORMAT,
        version = Payload.VERSION,
        exportedAt = Payload.to_iso(spec.exported_at, tz),
        exportedAtLocal = spec.exported_at,
        source = {
            app = "koreader",
            appVersion = spec.app_version,
            plugin = spec.plugin_version,
        },
        book = {
            title = book.title,
            authors = book.authors,
            language = book.language,
            pages = pages,
            file = {
                name = book.file and book.file.name,
                size = book.file and book.file.size,
                sha256 = book.file and book.file.sha256,
                partialMd5 = book.file and book.file.partial_md5,
            },
            highlights = highlights,
            threads = threads,
        },
    }
end

return Payload
