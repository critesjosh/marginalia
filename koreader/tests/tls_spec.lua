--- Specs for marginalia_tls.lua — hostname verification.
---
--- LuaSec calls `sni(host)` but never checks the certificate against it, so a
--- certificate legitimately issued for any other domain would pass chain
--- validation untouched. This is the code that closes that, and it is the
--- easiest thing in the plugin to get subtly wrong.

local H = require("spec_helper")
local TLS = require("marginalia_tls")

--- A stand-in for a LuaSec certificate.
local function certificate(spec)
    return {
        extensions = function()
            if not spec.sans then return {} end
            return { ["2.5.29.17"] = spec.sans }
        end,
        subject = function()
            local entries = {}
            if spec.common_name then
                table.insert(entries, { name = "commonName", value = spec.common_name })
            end
            return entries
        end,
    }
end

-- Plain names.
do
    H.ok(TLS.name_matches("lexici.netlify.app", "lexici.netlify.app"), "exact match")
    H.ok(TLS.name_matches("LEXICI.NETLIFY.APP", "lexici.netlify.app"), "certificate case is folded")
    H.ok(TLS.name_matches("lexici.netlify.app.", "lexici.netlify.app"), "a trailing dot is not a difference")
    H.ok(not TLS.name_matches("evil.example.com", "lexici.netlify.app"), "different host")
    H.ok(not TLS.name_matches("netlify.app", "lexici.netlify.app"), "parent domain is not a match")
end

-- Wildcards, only ever as a whole leftmost label.
do
    H.ok(TLS.name_matches("*.netlify.app", "lexici.netlify.app"), "one label")
    H.ok(not TLS.name_matches("*.netlify.app", "netlify.app"), "the wildcard needs something to match")
    H.ok(not TLS.name_matches("*.netlify.app", "a.b.netlify.app"), "a wildcard covers one label, not two")
    H.ok(not TLS.name_matches("*", "lexici.netlify.app"), "a bare star matches nothing")
    H.ok(not TLS.name_matches("lex*.netlify.app", "lexici.netlify.app"), "partial-label wildcards are not wildcards")
    H.ok(not TLS.name_matches("*.*.app", "lexici.netlify.app"), "only the leftmost label may be a wildcard")
end

-- The certificate the default endpoint actually presents, read off the live
-- host: `subject CN=*.netlify.app`, `SAN: DNS:*.netlify.app, DNS:netlify.app`.
-- The default relay has to work, so this case is pinned rather than imagined.
do
    local netlify = certificate({
        sans = { dNSName = { "*.netlify.app", "netlify.app" } },
        common_name = "*.netlify.app",
    })
    H.ok(TLS.verify_hostname(netlify, "lexici.netlify.app"), "the default endpoint verifies")
    H.ok(TLS.verify_hostname(netlify, "netlify.app"), "the bare apex is covered by its own SAN")
    H.ok(not TLS.verify_hostname(netlify, "lexici.netlify.app.evil.com"),
        "and a lookalike host is not")
end

-- Where the name is read from. A certificate with a usable SAN is judged on it
-- alone; the common name is a fallback for certificates that have no SAN, not a
-- second chance for ones whose SANs did not match.
do
    local san_only = certificate({ sans = { dNSName = { "lexici.netlify.app" } } })
    H.ok(TLS.verify_hostname(san_only, "lexici.netlify.app"), "matching SAN")

    local wrong_san_right_cn = certificate({
        sans = { dNSName = { "someone-else.example.com" } },
        common_name = "lexici.netlify.app",
    })
    local matched, reason = TLS.verify_hostname(wrong_san_right_cn, "lexici.netlify.app")
    H.ok(not matched, "a present SAN list is the whole story")
    H.contains(reason, "not valid for", "and the reader is told which host failed")

    local cn_only = certificate({ common_name = "lexici.netlify.app" })
    H.ok(TLS.verify_hostname(cn_only, "lexici.netlify.app"), "no SAN, so the common name is used")

    local wildcard_san = certificate({ sans = { dNSName = { "*.netlify.app" } } })
    H.ok(TLS.verify_hostname(wildcard_san, "lexici.netlify.app"), "wildcard SAN")

    local many = certificate({ sans = { dNSName = { "a.example.com", "b.example.com", "lexici.netlify.app" } } })
    H.ok(TLS.verify_hostname(many, "lexici.netlify.app"), "any one of several SANs will do")
end

-- A name is never matched against an address entry, or the other way round.
do
    local ip_san = certificate({ sans = { iPAddress = { "192.168.1.10" } } })
    H.ok(TLS.verify_hostname(ip_san, "192.168.1.10"), "address against address")
    H.ok(not TLS.verify_hostname(ip_san, "lexici.netlify.app"), "an address entry does not vouch for a name")

    local dns_san = certificate({ sans = { dNSName = { "192.168.1.10" } } })
    H.ok(not TLS.verify_hostname(dns_san, "192.168.1.10"), "a name entry does not vouch for an address")

    local wildcard_for_ip = certificate({ sans = { iPAddress = { "*.1.10" } } })
    H.ok(not TLS.verify_hostname(wildcard_for_ip, "192.168.1.10"), "addresses have no wildcards")
end

-- Everything that is not a clean answer is a refusal.
do
    local ok, reason = TLS.verify_hostname(nil, "lexici.netlify.app")
    H.ok(not ok, "no certificate is not a pass")
    H.contains(reason, "no certificate")

    local unicode = certificate({ sans = { dNSName = { "münchen.example.com" } } })
    local matched, why = TLS.verify_hostname(unicode, "münchen.example.com")
    H.ok(not matched, "an internationalised host is refused rather than half-matched")
    H.contains(why, "plain ASCII")

    -- LuaSec has been known to hand back shapes the docs do not describe.
    local broken = {
        extensions = function() error("no extensions here") end,
        subject = function() error("nor a subject") end,
    }
    H.ok(not TLS.verify_hostname(broken, "lexici.netlify.app"), "a certificate we cannot read is not trusted")

    local empty_sans = certificate({ sans = { dNSName = {} }, common_name = "lexici.netlify.app" })
    H.ok(TLS.verify_hostname(empty_sans, "lexici.netlify.app"),
        "an empty SAN list is no SAN list, so the common name is still consulted")
end

-- None of the above matters if the request can be made in the clear.
do
    H.ok(TLS.check_endpoint("https://lexici.netlify.app/api/chat"), "https is fine")

    local ok, why = TLS.check_endpoint("http://lexici.netlify.app/api/chat")
    H.ok(not ok, "http is refused")
    H.contains(why, "https://")

    H.ok(not TLS.check_endpoint("ftp://example.com"), "so is anything else")
    H.ok(not TLS.check_endpoint(""), "and nothing at all")
    H.ok(not TLS.check_endpoint(nil))
    H.ok(not TLS.check_endpoint("https://"), "a scheme with no host is not a URL")
end

print("tls_spec ok")
