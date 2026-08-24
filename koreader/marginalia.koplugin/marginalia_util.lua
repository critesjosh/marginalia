--[[--
The small device-facing helpers: entropy, hashing, and the clock.

@module marginalia.util
--]]

local sha2 = require("ffi/sha2")
local logger = require("logger")

local Util = {}

--[[--
Random hex, from the kernel.

KOReader's own `random.uuid` seeds `math.random` with `os.time()`, which makes
its output a function of the second the device booted — fine for a cache key,
useless for the prompt's fence delimiter, which is only worth anything if text
written before the request cannot predict it. So this reads `/dev/urandom` and
only falls back to `math.random` if that is unavailable, which on the supported
devices it is not.
--]]
function Util.random_hex(characters)
    local bytes = math.ceil(characters / 2)
    local file = io.open("/dev/urandom", "rb")
    if file then
        local raw = file:read(bytes)
        file:close()
        if raw and #raw == bytes then
            return (raw:gsub(".", function(byte)
                return string.format("%02X", byte:byte())
            end)):sub(1, characters)
        end
    end

    logger.warn("marginalia: /dev/urandom unavailable, falling back to math.random")
    local out = {}
    for _ = 1, bytes do
        out[#out + 1] = string.format("%02X", math.random(0, 255))
    end
    return table.concat(out):sub(1, characters)
end

--- A v4 UUID from the same entropy, lowercase, dashed.
function Util.uuid()
    local hex = Util.random_hex(32):lower()
    -- Version nibble is 4; variant nibble keeps its low two bits and sets 10.
    local variant = string.format("%x", tonumber(hex:sub(17, 17), 16) % 4 + 8)
    return table.concat({
        hex:sub(1, 8),
        hex:sub(9, 12),
        "4" .. hex:sub(14, 16),
        variant .. hex:sub(18, 20),
        hex:sub(21, 32),
    }, "-")
end

--- Lowercase SHA-256 of a string.
function Util.sha256_hex(text)
    return sha2.sha256(text):lower()
end

--- How much of a file we read per pass while hashing.
local HASH_CHUNK = 64 * 1024

--[[--
SHA-256 of a file, chunk by chunk.

This is the hash Marginalia identifies a book by (`src/lib/fingerprint.ts`), and
it has to be the whole file: the app deliberately refuses to reattach notes on
title and author, because two editions share those while numbering their
sections differently.

Pure-Lua hashing of a few megabytes takes long enough to notice, so callers run
this inside `Trapper:dismissableRunInSubprocess`. Chunking is about memory, not
responsiveness — it keeps a large book from being read into RAM whole on a
device that does not have much.

@treturn string lowercase hex, or nil plus a reason
--]]
function Util.sha256_file(path)
    local file, open_error = io.open(path, "rb")
    if not file then return nil, open_error or "could not open the book file" end

    local feed = sha2.sha256()
    while true do
        local chunk = file:read(HASH_CHUNK)
        if not chunk or #chunk == 0 then break end
        feed(chunk)
    end
    file:close()

    return feed():lower()
end

--- Device-local wall clock, in the shape KOReader writes into a sidecar.
function Util.now_local()
    return os.date("%Y-%m-%d %H:%M:%S")
end

--- The device's current UTC offset, as `+HHMM` / `-HHMM`.
function Util.tz_offset()
    local offset = os.date("%z")
    -- Some libcs spell it out ("Eastern Standard Time") instead of numerically;
    -- anything that is not the numeric form is no use for building a timestamp.
    if type(offset) == "string" and offset:match("^[+%-]%d%d%d%d$") then
        return offset
    end
    return nil
end

--- A filename-safe version of a book title.
function Util.slug(text)
    local clean = (text or "book"):gsub("[^%w]+", "-"):gsub("^%-+", ""):gsub("%-+$", ""):lower()
    if clean == "" then clean = "book" end
    return clean:sub(1, 60)
end

return Util
