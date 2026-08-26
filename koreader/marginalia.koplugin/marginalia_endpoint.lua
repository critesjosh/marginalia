--[[
Where a question goes, and what may be sent there.

Two kinds of endpoint live behind the plugin's settings:

- The Marginalia relay (the default): it holds the inference key server-side
  and pins the model, so the client sends only messages and cannot choose
  what a request costs.
- A server the reader runs themselves that speaks the OpenAI chat-completions
  dialect — llama-server, vLLM, Ollama, LM Studio — addressed by base URL,
  model name and an optional API key kept on the device.

The split matters for trust. A relay URL is always https and verified against
the device's certificate store. A self-hosted server usually has none of
that: it answers on plain http over the home network. Sending questions and
passages in the clear is acceptable exactly when the hop never leaves the
reader's own network, so plain http is accepted only for loopback, RFC 1918,
link-local, CGNAT and mDNS addresses — and refused everywhere else. There is
deliberately no switch that turns that off.

This module is pure: it requires nothing, so it runs under the fengari
harness alongside prompt, payload, view, digest and memory.

@module marginalia.endpoint
--]]

local Endpoint = {}

--- Ask through the hosted relay (`settings.endpoint`).
Endpoint.RELAY = "relay"

--- Ask a reader-run OpenAI-compatible server.
Endpoint.OPENAI_COMPATIBLE = "openai_compatible"

--- Joined to a self-hosted server's base URL when it carries no path of its own.
Endpoint.DEFAULT_PATH = "/v1/chat/completions"

--[[--
Whether a host is on the reader's own network.

`localhost` by name, loopback, RFC 1918 private ranges, link-local
(169.254.0.0/16), the CGNAT range (100.64.0.0/10 — which is where Tailscale
and similar overlays put their addresses) and `.local` mDNS names. Anything
else — a public IP, a domain — is not private, whatever the reader intends.

@param host a lowercase host name or IPv4 address, without port
@treturn boolean
--]]
function Endpoint.is_private_host(host)
    if type(host) ~= "string" or host == "" then return false end
    if host == "localhost" then return true end
    if host:find("%.local$") then return true end

    local a, b, c, d = host:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$")
    if not a then return false end
    a, b, c, d = tonumber(a), tonumber(b), tonumber(c), tonumber(d)
    if a > 255 or b > 255 or c > 255 or d > 255 then return false end

    if a == 127 or a == 10 then return true end
    if a == 192 and b == 168 then return true end
    if a == 172 and b >= 16 and b <= 31 then return true end
    if a == 169 and b == 254 then return true end
    if a == 100 and b >= 64 and b <= 127 then return true end
    return false
end

--[[--
Splits a URL into scheme, host (lowercased, port kept) and path.

The path may be absent — readers type bare base addresses — and comes back
as "/" in that case, so callers never see a missing component. Userinfo is
not parsed: an `user@host` endpoint simply fails the private-host check for
http and is refused, which is the safe direction.

@treturn string|nil scheme, string|nil authority, string|nil path starting with a slash
--]]
function Endpoint.parse_url(url)
    if type(url) ~= "string" then return nil end
    local scheme, authority = url:match("^(https?)://([^/]*)")
    if not scheme then return nil end
    local path = url:sub(#scheme + #authority + 3 + 1)
    if path ~= "" and path:sub(1, 1) ~= "/" then return nil end
    if path == "" then path = "/" end
    return scheme, authority:lower(), path
end

--[[--
Whether a URL asks for the verified-TLS connection factory.

Plain http must go over the socket KOReader ships — wrapping it in LuaSec
would attempt a TLS handshake against a server that answers in the clear,
and the request would die there.

@treturn boolean
--]]
function Endpoint.is_https(url)
    local scheme = Endpoint.parse_url(url)
    return scheme == "https"
end

--[[--
Strips the port from a `host:port` authority.
--]]
function Endpoint.host_of(authority)
    if not authority then return nil end
    return authority:match("^(.-):%d+$") or authority
end

--[[--
Whether a URL may be used at all.

An https URL is always allowed; the connection will be verified against the
device's certificate store, wherever it points. A plain-http URL is allowed
only when its host is on the reader's own network — see the module comment
for why that line sits where it does. Any other scheme is refused.

@treturn boolean ok
@return string reason, when not ok
--]]
function Endpoint.check(url)
    local scheme, authority = Endpoint.parse_url(url)
    if not scheme then
        if type(url) == "string" and url ~= "" then
            if url:match("^https:") or url:match("^http:") then
                return false, "That does not look like a URL."
            end
            return false, "The server address must start with http:// or https://."
        end
        return false, "No server address is set."
    end

    local host = Endpoint.host_of(authority)
    if not host or host == "" then
        return false, "That does not look like a URL."
    end

    if scheme == "https" then return true end

    if not Endpoint.is_private_host(host) then
        return false, "Plain http:// is only offered for addresses on your own "
            .. "network (the device itself, your router's subnet, or a .local name). "
            .. "Public addresses must use https://."
    end
    return true
end

--[[--
The chat-completions URL for a self-hosted server.

Readers enter whatever their server's documentation calls the base address,
so every reasonable shape lands on the same place:

    http://kobo-box:8080                      -> .../v1/chat/completions
    http://192.168.1.50:8000/v1               -> .../v1/chat/completions
    https://host.ts.net/v1/chat/completions   -> unchanged

A path that is none of those is treated as a prefix, for deployments mounted
under something like `/api`.
--]]
function Endpoint.chat_url(url)
    local scheme, authority, rest = Endpoint.parse_url(url)
    if not scheme then return nil end
    local path = rest:gsub("/+$", "")
    if path:find("/chat/completions$") then
        return scheme .. "://" .. authority .. path
    end
    if path:find("/v1$") then
        path = path:sub(1, -4)
    end
    return scheme .. "://" .. authority .. path .. Endpoint.DEFAULT_PATH
end

--[[--
Turns settings into a request plan.

Nothing here talks to the network: the caller decides what a plan means, and
`marginalia_relay` turns one into a request. A plan that could not be built
comes back as `nil, reason`, with the reason written to be shown to the
reader as it stands.

Settings read:

- `inference` — `Endpoint.RELAY` (default) or `Endpoint.OPENAI_COMPATIBLE`
- `endpoint` — the relay's URL, when the relay is chosen
- `server_url`, `model`, `api_key` — the own-server triple

@treturn table plan carrying kind, url and, for own servers, model and api_key
@return string reason, when the plan could not be built
--]]
function Endpoint.plan(settings)
    settings = settings or {}
    if settings.inference ~= Endpoint.OPENAI_COMPATIBLE then
        local url = settings.endpoint
        local usable, why = Endpoint.parse_url(url) and true or false
        if not usable then
            -- Fall back to the wording the relay path has always used.
            return nil, "No Marginalia endpoint is set."
        end
        return { kind = Endpoint.RELAY, url = url }
    end

    local url = settings.server_url
    if type(url) ~= "string" or (url:gsub("%s+", "")) == "" then
        return nil, "Set the server address in the Marginalia settings first."
    end
    url = (url:gsub("^%s+", "")):gsub("%s+$", "")
    local usable, why = Endpoint.check(url)
    if not usable then return nil, why end

    local model = settings.model
    if type(model) ~= "string" or (model:gsub("%s+", "")) == "" then
        return nil, "Set the model name in the Marginalia settings first."
    end
    model = (model:gsub("^%s+", "")):gsub("%s+$", "")

    local api_key = settings.api_key
    if type(api_key) ~= "string" or (api_key:gsub("%s+", "")) == "" then
        api_key = nil
    end

    return {
        kind = Endpoint.OPENAI_COMPATIBLE,
        url = Endpoint.chat_url(url),
        model = model,
        api_key = api_key,
    }
end

--[[--
Headers for an OpenAI-compatible chat request.

Servers in the wild disagree about authentication: vLLM's `--api-key` wants a
bearer token, llama-server accepts any value or none, Ollama ignores the
header. So the header appears exactly when the reader set a key, and never
otherwise — an absent header cannot leak anything about the setup.

@treturn table headers for `socket.http`
--]]
function Endpoint.headers(api_key)
    local headers = {
        ["Content-Type"] = "application/json",
        ["Accept"] = "application/json",
    }
    if api_key then
        headers["Authorization"] = "Bearer " .. api_key
    end
    return headers
end

return Endpoint
