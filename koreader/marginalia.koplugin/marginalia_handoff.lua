--[[--
Writing the handoff file the Marginalia web reader imports.

The file goes to `<datadir>/marginalia/`, which on a Kindle is
`/mnt/us/koreader/marginalia/` — a directory that shows up when the device is
plugged in over USB. That is the whole transport: there is no server to sync
through, because Marginalia keeps everything in the browser's own storage and
has no accounts to sync against.

The expensive part is the SHA-256 of the EPUB, which is how the web app decides
which book a highlight belongs to. It refuses to match on title and author —
two editions share those while numbering their sections differently, so a
highlight handed to the wrong edition lands on arbitrary text. Hashing a few
megabytes in pure Lua takes long enough to notice, so it runs in a Trapper
subprocess and the result is cached against the file's size and mtime.

@module marginalia.handoff
--]]

local DataStorage = require("datastorage")
local InfoMessage = require("ui/widget/infomessage")
local Trapper = require("ui/trapper")
local UIManager = require("ui/uimanager")
local Version = require("version")
local lfs = require("libs/libkoreader-lfs")
local logger = require("logger")
local rapidjson = require("rapidjson")
local _ = require("gettext")
local T = require("ffi/util").template

local Payload = require("marginalia_payload")
local Store = require("marginalia_store")
local Util = require("marginalia_util")

--- Matches the context budget used when asking about a passage.
local CONTEXT_WORDS = 80

local Handoff = {}

function Handoff:new(o)
    o = o or {}
    setmetatable(o, self)
    self.__index = self
    return o
end

--- Where exports land, created on demand.
function Handoff.directory()
    local path = DataStorage:getFullDataDir() .. "/marginalia"
    if lfs.attributes(path, "mode") ~= "directory" then
        lfs.mkdir(path)
    end
    return path
end

--[[--
The book's SHA-256, hashed if we do not already have it for these exact bytes.

Cached against size and mtime rather than recomputed: a reader who exports after
every session should pay for this once.
--]]
function Handoff:file_hash(path, data)
    local attributes = lfs.attributes(path)
    if not attributes then return nil, "could not read the book file" end

    local cached = data.file_hash
    if cached and cached.sha256 and cached.size == attributes.size
        and cached.mtime == attributes.modification then
        return cached.sha256
    end

    local completed, result = Trapper:dismissableRunInSubprocess(function()
        local hash, err = Util.sha256_file(path)
        return { sha256 = hash, error = err }
    end, _("Identifying the book…"))

    if not completed then return nil, "cancelled" end
    if type(result) ~= "table" or not result.sha256 then
        return nil, (type(result) == "table" and result.error) or "could not hash the book file"
    end

    data.file_hash = {
        sha256 = result.sha256,
        size = attributes.size,
        mtime = attributes.modification,
    }
    return result.sha256
end

--[[--
Prose around each highlight, taken from the open document.

Only the book being read can supply this: the sidecar stores where a highlight
is, not what surrounds it. Anything that fails is simply left without context,
which the web app already treats as optional.
--]]
function Handoff:contexts(annotations)
    local contexts = {}
    if not self.ui.rolling then return contexts end

    for _, annotation in ipairs(annotations) do
        if annotation.pos0 and annotation.pos1 and annotation.text then
            local ok, before, after = pcall(function()
                return self.ui.document:getSelectedWordContext(
                    annotation.text, CONTEXT_WORDS, annotation.pos0, annotation.pos1, false)
            end)
            if ok then
                local parts = {}
                for _, part in ipairs({ before, annotation.text, after }) do
                    if type(part) == "string" then
                        local clean = part:gsub("%s+", " "):gsub("^ ", ""):gsub(" $", "")
                        if clean ~= "" then table.insert(parts, clean) end
                    end
                end
                if #parts > 1 then
                    contexts[Payload.external_id(annotation, Util.sha256_hex)] =
                        table.concat(parts, " ")
                end
            end
        end
    end

    return contexts
end

--- Only EPUBs: the web app reads nothing else, and a PDF's positions are pixel
--- boxes that mean nothing to it.
function Handoff:is_exportable()
    local path = self.ui.document and self.ui.document.file
    return type(path) == "string" and path:lower():sub(-5) == ".epub"
end

--[[--
Exports the open book. Runs inside its own Trapper wrap.
--]]
function Handoff:export()
    if not self:is_exportable() then
        UIManager:show(InfoMessage:new{
            text = _("Marginalia reads EPUB files, so only EPUBs can be exported."),
        })
        return
    end

    Trapper:wrap(function()
        local path = self.ui.document.file
        local data = Store.read(self.ui.doc_settings)
        local annotations = self.ui.annotation.annotations or {}

        local highlight_count = 0
        for _, annotation in ipairs(annotations) do
            if type(annotation.text) == "string" and annotation.text:match("%S") then
                highlight_count = highlight_count + 1
            end
        end

        if highlight_count == 0 and #(data.threads or {}) == 0 then
            UIManager:show(InfoMessage:new{
                text = _("This book has no highlights to export yet."),
            })
            return
        end

        local hash, hash_error = self:file_hash(path, data)
        if not hash then
            if hash_error ~= "cancelled" then
                UIManager:show(InfoMessage:new{
                    text = T(_("Could not identify the book: %1"), hash_error),
                })
            end
            return
        end
        -- The hash was possibly just computed; keep it for next time.
        Store.write(self.ui.doc_settings, data)

        local attributes = lfs.attributes(path)
        local props = self.ui.doc_props or {}

        local document = Payload.build{
            book = {
                title = props.display_title or props.title,
                authors = props.authors,
                language = props.language,
                publisher = props.publisher,
                published = props.series or nil,
                pages = self.ui.doc_settings:readSetting("doc_pages"),
                file = {
                    name = path:match("([^/]+)$"),
                    size = attributes and attributes.size,
                    sha256 = hash,
                    partial_md5 = self.ui.doc_settings:readSetting("partial_md5_checksum"),
                },
            },
            annotations = annotations,
            contexts = self:contexts(annotations),
            threads = data.threads,
            exported_at = Util.now_local(),
            tz_offset = Util.tz_offset(),
            app_version = Version:getShortVersion(),
            plugin_version = self.plugin_version,
            sha256_hex = Util.sha256_hex,
        }

        local encoded, encode_error = rapidjson.encode(document, { pretty = true })
        if not encoded then
            logger.warn("marginalia: could not encode export", encode_error)
            UIManager:show(InfoMessage:new{ text = _("Could not build the export file.") })
            return
        end

        local filename = string.format("%s-%s.json",
            Util.slug(props.display_title or props.title),
            os.date("%Y%m%d-%H%M%S"))
        local destination = Handoff.directory() .. "/" .. filename

        local file, open_error = io.open(destination, "w")
        if not file then
            UIManager:show(InfoMessage:new{
                text = T(_("Could not write the export: %1"), tostring(open_error)),
            })
            return
        end
        file:write(encoded)
        file:write("\n")
        file:close()

        UIManager:show(InfoMessage:new{
            text = T(_("Exported %1 highlights to:\n\n%2\n\nOpen Marginalia, go to Settings, and import this file."),
                highlight_count, destination),
        })
    end)
end

return Handoff
