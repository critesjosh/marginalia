--[[--
A verified TLS connection factory for LuaSocket's `http.request`.

KOReader ships LuaSec configured with `verify = "none"` (`common/ssl/https.lua`),
so every plugin that talks HTTPS gets an encrypted channel to *whoever answers*.
That is fine for fetching a public Wikipedia article. It is not fine here: what
goes over this connection is the reader's own questions, the passage they chose,
and where they are in a book.

Two separate things have to be true, and LuaSec gives us neither by default.

**The chain must be trusted.** `socket.http` copies the request table into the
normalised request and hands it to the scheme's `create` (`common/socket/http.lua`),
and LuaSec's `tcp(params)` fills in only the values the caller left unset. So
passing `verify = "peer"` and a `cafile` overrides the shipped default. The
device already carries a bundle at `<datadir>/data/ca-bundle.crt`.

**The certificate must be for the host we asked for.** LuaSec calls `sni(host)`
but never checks the certificate against it, so a valid certificate issued for
any other domain would sail through chain validation. That check is this module's
real work, and it is done here rather than trusted to LuaSec.

Note that supplying our own `create` means `socket.http` never calls
`SCHEMES.https.create`, so the LuaSec factory is built here explicitly rather
than by leaving parameters on the request table for it to pick up.

Failures raise through `socket.try`, which is how LuaSec's own connect reports
problems and what `socket.protect` around `http.request` turns back into
`nil, message`.

@module marginalia.tls
--]]

local socket = require("socket")

local TLS = {}

--- OID of subjectAltName, the key LuaSec's `extensions()` files SANs under.
local SUBJECT_ALT_NAME = "2.5.29.17"

--[[--
Normalises a host for comparison: lowercase, trailing dot removed.

Only ASCII case folding, which is all DNS names need — and non-ASCII hosts are
refused outright rather than guessed at, since matching an internationalised
name properly means punycode, and getting it half right is worse than declining.
--]]
local function normalize_host(host)
    if type(host) ~= "string" or host == "" then return nil end
    local clean = host:gsub("%.$", ""):lower()
    if clean:match("[\128-\255]") then return nil end
    return clean
end

--[[--
Matches one certificate name against a host.

Wildcards are honoured only as a complete leftmost label — `*.example.com`
matches `a.example.com` but not `example.com`, not `a.b.example.com`, and
`w*.example.com` is not a wildcard at all.
--]]
function TLS.name_matches(pattern, host)
    pattern = normalize_host(pattern)
    if not pattern or not host then return false end
    if pattern == host then return true end

    local rest = pattern:match("^%*%.(.+)$")
    if not rest then return false end

    local label, remainder = host:match("^([^%.]+)%.(.+)$")
    return label ~= nil and remainder == rest
end

--[[--
Checks a peer certificate against the host we meant to reach.

Follows the usual rule: if the certificate carries any subjectAltName of the
relevant kind, those are the whole story and the common name is not consulted.
A common name is only a fallback for certificates old enough to have no SAN.

@param cert a LuaSec certificate, or nil
@param host the requested host
@treturn boolean matched
@treturn string reason, when it did not
--]]
function TLS.verify_hostname(cert, host)
    local wanted = normalize_host(host)
    if not wanted then
        return false, "the endpoint host is not a plain ASCII name"
    end
    if not cert then
        return false, "the server sent no certificate"
    end

    local ok, extensions = pcall(cert.extensions, cert)
    local alt = ok and type(extensions) == "table" and extensions[SUBJECT_ALT_NAME] or nil

    -- An IP literal is only ever matched against an iPAddress entry, and a name
    -- only against dNSName. Crossing them over is a classic way to be fooled,
    -- and `is_ip and alt.iPAddress or alt.dNSName` does exactly that whenever
    -- the address list is absent — so the choice is spelled out instead.
    local is_ip = wanted:match("^%d+%.%d+%.%d+%.%d+$") ~= nil
    local names
    if alt then
        names = is_ip and alt.iPAddress or (not is_ip and alt.dNSName) or nil
    end

    if type(names) == "table" and #names > 0 then
        for _, name in ipairs(names) do
            if is_ip then
                if normalize_host(name) == wanted then return true end
            elseif TLS.name_matches(name, wanted) then
                return true
            end
        end
        return false, "the certificate is not valid for " .. host
    end

    -- No usable SAN. Fall back to the common name, which modern certificates
    -- do not rely on but older ones still carry.
    local subject_ok, subject = pcall(cert.subject, cert)
    if subject_ok and type(subject) == "table" then
        for _, entry in ipairs(subject) do
            if entry.name == "commonName" and TLS.name_matches(entry.value, wanted) then
                return true
            end
        end
    end

    return false, "the certificate is not valid for " .. host
end

--[[--
Builds a `create` function for `http.request` that verifies chain and hostname.

@param host the host being requested, for the hostname check
@param cafile absolute path to a PEM bundle of trusted roots
@treturn function suitable as `create` on a LuaSocket request table
--]]
function TLS.create(host, cafile)
    local https = require("ssl.https")

    local factory = https.tcp({
        mode = "client",
        protocol = "any",
        -- TLS 1.2 is the floor. Everything below it is either broken or on its
        -- way there, and no endpoint this plugin talks to needs them.
        options = { "all", "no_sslv2", "no_sslv3", "no_tlsv1", "no_tlsv1_1" },
        verify = "peer",
        cafile = cafile,
    })

    return function()
        local conn = factory()
        local connect = conn.connect

        conn.connect = function(self, connect_host, connect_port)
            -- LuaSec's own connect raises on handshake or chain failure, which
            -- is what carries a rejected certificate back to the caller.
            local result = connect(self, connect_host, connect_port)

            local cert
            local ok, value = pcall(function() return self:getpeercertificate() end)
            if ok then cert = value end

            local matched, reason = TLS.verify_hostname(cert, host)
            if not matched then
                pcall(function() self:close() end)
                socket.try(nil, reason)
            end

            return result
        end

        return conn
    end
end

--[[--
Whether an endpoint may be used at all.

`http://` is refused rather than downgraded silently: everything above is beside
the point if the request can be made in the clear.
--]]
function TLS.check_endpoint(url)
    if type(url) ~= "string" or url == "" then
        return false, "No Marginalia endpoint is set."
    end
    if url:match("^http://") then
        return false, "The Marginalia endpoint must be an https:// address."
    end
    if not url:match("^https://") then
        return false, "The Marginalia endpoint must start with https://."
    end
    if not url:match("^https://[^/]+") then
        return false, "That does not look like a URL."
    end
    return true
end

return TLS
