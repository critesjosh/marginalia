--- Specs for marginalia_endpoint.lua — where a question may go, and as what.

local H = require("spec_helper")
local Endpoint = require("marginalia_endpoint")

-- Plain http is the whole risk, so the private-network line has to hold on
-- both sides: everything a home network actually uses passes, and lookalikes
-- just outside each range do not.
do
    local private = {
        "localhost",
        "127.0.0.1", "127.255.255.254",
        "10.0.0.1", "10.255.0.9",
        "192.168.1.50", "192.168.0.0",
        "172.16.0.1", "172.31.254.9",
        "169.254.1.1",
        "100.64.0.1", "100.127.255.254",
        "kobo-box.local", "server.local",
    }
    for _, host in ipairs(private) do
        H.ok(Endpoint.is_private_host(host), "private: " .. host)
    end

    local public = {
        "8.8.8.8",
        "1.1.1.1",
        "example.com",
        "localhost.example.com",
        "192.167.0.1",   -- one below the private range
        "192.169.0.1",   -- one above it
        "172.15.0.1",
        "172.32.0.1",
        "100.63.0.1",    -- one below CGNAT
        "100.128.0.1",   -- one above it
        "999.1.1.1",     -- not an octet
        "1.2.3",         -- not four octets
        "",
        nil,
    }
    for _, host in ipairs(public) do
        H.ok(not Endpoint.is_private_host(host), "public: " .. tostring(host))
    end
end

-- Endpoint acceptance. https:// is always fine; plain http only at home;
-- anything else refused with something a reader can act on.
do
    H.ok(Endpoint.check("https://lexici.netlify.app/api/chat"))
    H.ok(Endpoint.check("https://box.tail1234.ts.net/v1"))
    H.ok(Endpoint.check("http://192.168.1.50:8080"))
    H.ok(Endpoint.check("http://localhost:11434"))
    H.ok(Endpoint.check("http://my-box.local:8080/v1"))

    local ok, why = Endpoint.check("http://api.example.com/v1")
    H.ok(not ok)
    H.contains(why, "your own", "a public http address explains itself")

    ok, why = Endpoint.check("ftp://192.168.1.50")
    H.ok(not ok)
    H.contains(why, "http:// or https://")

    ok, why = Endpoint.check("")
    H.ok(not ok)

    ok, why = Endpoint.check("https://")
    H.ok(not ok)
    H.contains(why, "does not look like a URL")

    ok, why = Endpoint.check(nil)
    H.ok(not ok)
end

-- Base-address shapes. Readers paste whatever their server's docs call the
-- base URL; every reasonable shape lands on /v1/chat/completions exactly once.
do
    local J = Endpoint.DEFAULT_PATH
    H.equal(Endpoint.chat_url("http://192.168.1.50:8080"),
        "http://192.168.1.50:8080" .. J, "bare host gains the path")
    H.equal(Endpoint.chat_url("http://192.168.1.50:8080/"),
        "http://192.168.1.50:8080" .. J, "trailing slash does not double")
    H.equal(Endpoint.chat_url("http://kobo-box.local:8000/v1"),
        "http://kobo-box.local:8000" .. J, "a /v1 suffix is folded in")
    H.equal(Endpoint.chat_url("https://box.ts.net/v1/chat/completions"),
        "https://box.ts.net/v1/chat/completions", "a full URL is left alone")
    H.equal(Endpoint.chat_url("http://192.168.1.50:8080/api"),
        "http://192.168.1.50:8080/api" .. J, "another mount path is kept as a prefix")
    H.nil_(Endpoint.chat_url("not a url"))
end

-- Plans. The settings table decides between relay and own server, and every
-- failure names what the reader has to go set.
do
    -- Default (no `inference` key at all — settings written by older versions).
    local plan = Endpoint.plan({ endpoint = "https://lexici.netlify.app/api/chat" })
    H.equal(plan.kind, Endpoint.RELAY)
    H.equal(plan.url, "https://lexici.netlify.app/api/chat")
    H.nil_(plan.model)

    plan = Endpoint.plan({ inference = Endpoint.RELAY, endpoint = "https://r.example/api/chat" })
    H.equal(plan.kind, Endpoint.RELAY)

    local nil_plan, why = Endpoint.plan({ inference = Endpoint.OPENAI_COMPATIBLE })
    H.nil_(nil_plan)
    H.contains(why, "server address")

    nil_plan, why = Endpoint.plan({ inference = Endpoint.OPENAI_COMPATIBLE,
        server_url = "http://example.com" })
    H.nil_(nil_plan)
    H.contains(why, "your own", "the privacy rule holds through plans too")

    nil_plan, why = Endpoint.plan({ inference = Endpoint.OPENAI_COMPATIBLE,
        server_url = "http://192.168.1.50:8080" })
    H.nil_(nil_plan)
    H.contains(why, "model name")

    plan = Endpoint.plan({ inference = Endpoint.OPENAI_COMPATIBLE,
        server_url = "  http://192.168.1.50:8080  ",
        model = " qwen3-32b " })
    H.equal(plan.kind, Endpoint.OPENAI_COMPATIBLE)
    H.equal(plan.url, "http://192.168.1.50:8080" .. Endpoint.DEFAULT_PATH)
    H.equal(plan.model, "qwen3-32b")
    H.nil_(plan.api_key)

    plan = Endpoint.plan({ inference = Endpoint.OPENAI_COMPATIBLE,
        server_url = "http://192.168.1.50:8080",
        model = "qwen3-32b",
        api_key = "sk-local" })
    H.equal(plan.api_key, "sk-local")

    plan = Endpoint.plan({ inference = Endpoint.OPENAI_COMPATIBLE,
        server_url = "http://192.168.1.50:8080",
        model = "qwen3-32b",
        api_key = "   " })
    H.nil_(plan.api_key, "a blank key is no key")
end

-- Headers carry a bearer token only when there is one to carry.
do
    local headers = Endpoint.headers(nil)
    H.nil_(headers["Authorization"])
    H.equal(headers["Content-Type"], "application/json")

    headers = Endpoint.headers("sk-local")
    H.equal(headers["Authorization"], "Bearer sk-local")
end

-- Only https asks for the verified-TLS factory; plain http must ride the
-- connection KOReader ships, or the request would try to speak TLS at a
-- server answering in the clear.
do
    H.ok(Endpoint.is_https("https://box.ts.net/v1/chat/completions"))
    H.ok(not Endpoint.is_https("http://192.168.1.50:8080/v1/chat/completions"))
    H.ok(not Endpoint.is_https("not a url"))
    H.ok(not Endpoint.is_https(nil))
end

print("endpoint_spec ok")
