--[[--
The client for Marginalia's inference relay.

The relay (`shared/relay.ts` in the web app) holds the OpenRouter key server
side and pins the model, so this plugin needs no key of its own and cannot
choose what a request costs. It rejects requests from other *pages* by checking
`Origin`, and treats a request without that header as same-origin — which is
what a non-browser client sends. That is deliberate, not an oversight; the
comment on `isCrossOrigin` says so.

The request itself blocks: LuaSocket has no non-blocking mode here, and
KOReader's turbo-based async client is unusable because `DUSE_TURBO_LIB` is
false in `defaults.lua`, which leaves `UIManager.looper` nil. So the caller runs
`post` inside `Trapper:dismissableRunInSubprocess`, which forks it, keeps the UI
painting and lets the reader tap to give up. Everything this returns therefore
has to survive being serialised across that fork: plain tables, strings and
numbers only.

@module marginalia.relay
--]]

local http = require("socket.http")
local ltn12 = require("ltn12")
local rapidjson = require("rapidjson")
local socketutil = require("socketutil")
local TLS = require("marginalia_tls")
local logger = require("logger")

local Relay = {}

--- Time to wait on a socket that has gone quiet, and overall.
-- Generous, because a model can take a while to say anything, and because the
-- real escape hatch is the reader dismissing the trap widget, not a timer.
local BLOCK_TIMEOUT = 20
local TOTAL_TIMEOUT = 120

--- Ceiling on a reply. The relay caps output at 1500 tokens, so anything past
--- this is a misbehaving endpoint rather than a long answer.
local MAX_RESPONSE_BYTES = 256 * 1024

--- Ceiling on a request, mirroring the relay's own `MAX_TOTAL_CHARS`.
local MAX_REQUEST_CHARS = 120000

--[[--
A sink that stops accepting data past a byte ceiling.

`socketutil.table_sink` bounds how long a body may take to arrive but not how
much of it there may be, so an endpoint that streams forever would fill memory
on a device that has very little.
--]]
local function capped_sink(chunks)
    local received = 0
    return function(chunk, err)
        if not chunk then return 1, err end
        received = received + #chunk
        if received > MAX_RESPONSE_BYTES then
            return nil, "response too large"
        end
        chunks[#chunks + 1] = chunk
        return 1
    end
end

local function host_of(url)
    return url:match("^https://([^/:]+)")
end

--- Pulls the relay's own sentence out of an error body, when it sent one.
local function upstream_message(body)
    local ok, decoded = pcall(rapidjson.decode, body or "")
    if ok and type(decoded) == "table" and type(decoded.error) == "table" then
        local message = decoded.error.message
        if type(message) == "string" and message ~= "" then return message end
    end
    return nil
end

local function status_message(code, body)
    local from_relay = upstream_message(body)
    if from_relay then return from_relay end
    if code == 429 then
        return "Marginalia is rate limiting this device. Wait a minute and try again."
    elseif code == 503 then
        return "That Marginalia deployment has no inference key configured."
    elseif code == 403 then
        return "Marginalia refused the request."
    elseif code == 404 then
        return "No relay at that address. Check the endpoint in the Marginalia settings."
    end
    return string.format("Marginalia answered with status %s.", tostring(code))
end

--[[--
Total characters in a message list, for the relay's own ceiling.
--]]
function Relay.request_size(messages)
    local total = 0
    for _, message in ipairs(messages or {}) do
        total = total + #(message.content or "")
    end
    return total
end

--[[--
Posts a conversation and returns the reply.

Blocking. Intended to be called inside `Trapper:dismissableRunInSubprocess`.

@param endpoint https URL of the relay
@param messages array of { role, content }
@param cafile path to the trusted-roots bundle
@param plugin_version string, sent for identification
@treturn table { ok = true, text = "…" } or { ok = false, error = "…" }
--]]
function Relay.post(endpoint, messages, cafile, plugin_version)
    local usable, why = TLS.check_endpoint(endpoint)
    if not usable then return { ok = false, error = why } end

    local host = host_of(endpoint)
    if not host then
        return { ok = false, error = "Could not read a host out of the endpoint." }
    end

    if Relay.request_size(messages) > MAX_REQUEST_CHARS then
        return { ok = false, error = "This conversation has grown too long for the relay. Start a new one." }
    end

    local encoded, encode_error = rapidjson.encode({
        messages = messages,
        stream = false,
    })
    if not encoded then
        return { ok = false, error = "Could not encode the request: " .. tostring(encode_error) }
    end

    local chunks = {}
    socketutil:set_timeout(BLOCK_TIMEOUT, TOTAL_TIMEOUT)
    local _, code, _, status = http.request({
        url = endpoint,
        method = "POST",
        source = ltn12.source.string(encoded),
        sink = capped_sink(chunks),
        create = TLS.create(host, cafile),
        headers = {
            ["Content-Type"] = "application/json",
            ["Content-Length"] = tostring(#encoded),
            ["Accept"] = "application/json",
            ["X-Marginalia-Client"] = "koreader/" .. tostring(plugin_version),
        },
    })
    socketutil:reset_timeout()

    local body = table.concat(chunks)

    if type(code) ~= "number" then
        -- LuaSocket reports transport and certificate failures here as a string.
        return { ok = false, error = Relay.transport_message(code) }
    end

    if code >= 300 and code < 400 then
        return { ok = false, error = "That endpoint redirects. Point the setting at the relay itself." }
    end

    if code ~= 200 then
        logger.warn("marginalia: relay returned", code, status)
        return { ok = false, error = status_message(code, body) }
    end

    -- The upstream provider pads a non-streaming reply with whitespace-only
    -- keep-alive lines before the JSON — measured against the live relay, which
    -- returned nine such lines ahead of the body. Most parsers skip leading
    -- whitespace, but this does not depend on that.
    local ok, decoded = pcall(rapidjson.decode, (body:gsub("^%s+", "")))
    if not ok or type(decoded) ~= "table" then
        return { ok = false, error = "Marginalia sent a reply this plugin could not read." }
    end

    local choice = decoded.choices and decoded.choices[1]
    local text = choice and choice.message and choice.message.content
    if type(text) ~= "string" or text:match("^%s*$") then
        return { ok = false, error = "The model returned an empty answer. Try asking again." }
    end

    return { ok = true, text = text }
end

--[[--
Turns LuaSocket's transport errors into something a reader can act on.

The certificate cases matter most: an e-reader with a wrong clock fails
validation in a way that reads as a network fault unless it is named.
--]]
function Relay.transport_message(err)
    err = tostring(err or "unknown error")

    if err:match("certificate verify failed") or err:match("unable to get local issuer") then
        return "Could not verify the server's certificate. If this device's clock is wrong, "
            .. "fix the date first — the Time sync plugin does it."
    end
    if err:match("^the certificate is not valid") or err:match("^the server sent no certificate") then
        return "The server's certificate is not for that address, so the connection was refused. " .. err
    end
    if err:match("host not found") or err:match("Name or service not known") then
        return "Could not find that host. Check Wi-Fi and the endpoint address."
    end
    if err:match("timeout") then
        return "The relay did not answer in time. Try again."
    end
    if err:match("connection refused") then
        return "The relay refused the connection."
    end
    if err == "response too large" then
        return "The reply was too large to read."
    end
    return "Could not reach Marginalia: " .. err
end

return Relay
