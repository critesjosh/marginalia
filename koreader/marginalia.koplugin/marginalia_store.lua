--[[--
Where a book's Marginalia threads live.

In the book's own sidecar, under one `marginalia` key, next to KOReader's
annotations. That means they travel with the book, survive a restart, are picked
up verbatim by the export, and need no storage of this plugin's own.

The one trap: `LuaSettings:saveSetting` only mutates the in-memory table. It is
`flush` that writes the file, and a sidecar that is never flushed is lost the
moment KOReader is killed rather than closed — which on an e-reader is the
normal way for it to end. So every write here flushes.

@module marginalia.store
--]]

local Util = require("marginalia_util")

local Store = {}

Store.KEY = "marginalia"
Store.VERSION = 1

--[[--
Reads this book's Marginalia data, always returning a usable table.
--]]
function Store.read(doc_settings)
    local stored = doc_settings and doc_settings:readSetting(Store.KEY)
    if type(stored) ~= "table" then
        return { version = Store.VERSION, threads = {} }
    end
    if type(stored.threads) ~= "table" then
        stored.threads = {}
    end
    stored.version = stored.version or Store.VERSION
    return stored
end

--- Writes and flushes, so a kill rather than a clean close does not lose the thread.
function Store.write(doc_settings, data)
    if not doc_settings then return end
    doc_settings:saveSetting(Store.KEY, data)
    doc_settings:flush()
end

--[[--
The thread hanging off a given highlight, if there is one.
--]]
function Store.find_thread(data, highlight_ref)
    if not highlight_ref then return nil end
    for _, thread in ipairs(data.threads or {}) do
        if thread.highlight_ref == highlight_ref then return thread end
    end
    return nil
end

--[[--
Starts a thread against a highlight.

`seed_text`, `context`, `chapter` and `progress` are snapshotted here rather
than looked up at export time, because by then the selection is long gone and
the reader may be somewhere else entirely in the book.
--]]
function Store.new_thread(spec)
    return {
        id = "koreader:" .. Util.uuid(),
        highlight_ref = spec.highlight_ref,
        title = spec.title,
        seed_text = spec.seed_text,
        context = spec.context,
        chapter = spec.chapter,
        progress = spec.progress,
        created_at = Util.now_local(),
        messages = {},
    }
end

--- Appends one turn. Messages are never edited once written, only added to.
function Store.append_message(thread, role, content)
    local message = {
        id = "koreader:" .. Util.uuid(),
        role = role,
        content = content,
        created_at = Util.now_local(),
    }
    table.insert(thread.messages, message)
    return message
end

--- Puts a thread into the book's data if it is not already there.
function Store.upsert_thread(data, thread)
    for index, existing in ipairs(data.threads) do
        if existing.id == thread.id then
            data.threads[index] = thread
            return
        end
    end
    table.insert(data.threads, thread)
end

--- Just the turns, in the shape the prompt builder wants.
function Store.history(thread)
    local history = {}
    for _, message in ipairs(thread and thread.messages or {}) do
        table.insert(history, { role = message.role, content = message.content })
    end
    return history
end

return Store
