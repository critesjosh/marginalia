--[[--
The ask-a-question flow: selection, question, answer, follow-up.

Two ordering decisions here are deliberate.

**Everything is snapshotted while the selection is still live.** The passage, its
positions and the prose around it all come from crengine, which only knows about
a selection while the popup is open. By the time a question has been typed the
selection is gone, so the snapshot is taken first and the dialog works from it.

**The annotation is created only once a question has actually been asked.**
Opening the input dialog and changing your mind is not an act of highlighting,
and should not litter the book with marks.

@module marginalia.ask
--]]

local Event = require("ui/event")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local NetworkMgr = require("ui/network/manager")
local TextViewer = require("ui/widget/textviewer")
local Trapper = require("ui/trapper")
local UIManager = require("ui/uimanager")
local util = require("util")
local logger = require("logger")
local _ = require("gettext")

local Payload = require("marginalia_payload")
local Prompt = require("marginalia_prompt")
local Relay = require("marginalia_relay")
local Store = require("marginalia_store")
local View = require("marginalia_view")
local Util = require("marginalia_util")

--- How many words either side of the passage to send as context. The web app
--- budgets about 1200 characters each way; eighty words is the same order.
local CONTEXT_WORDS = 80

local Ask = {}

function Ask:new(o)
    o = o or {}
    setmetatable(o, self)
    self.__index = self
    return o
end

--[[--
Captures everything about the current selection, before the popup closes.
--]]
function Ask:snapshot(highlight)
    local selection = highlight.selected_text
    if not (selection and selection.pos0 and selection.pos1) then return nil end

    local text = util.cleanupSelectedText(selection.text or "")
    if text == "" then return nil end

    -- Only meaningful for reflowable documents; a paging document's pos0 is a
    -- table of page and coordinates, which the export carries but nothing reads.
    local page_anchor = self.ui.rolling and selection.pos0 or selection.pos0.page

    local chapter
    local ok, title = pcall(function()
        return self.ui.toc:getTocTitleByPage(page_anchor)
    end)
    if ok then chapter = title end

    local pageno
    if self.ui.rolling then
        local page_ok, page = pcall(function()
            return self.ui.document:getPageFromXPointer(selection.pos0)
        end)
        if page_ok then pageno = page end
    else
        pageno = selection.pos0.page
    end

    local pages = self.ui.doc_settings and self.ui.doc_settings:readSetting("doc_pages")
    local progress
    if pageno and pages and pages > 0 then progress = pageno / pages end

    return {
        text = text,
        pos0 = selection.pos0,
        pos1 = selection.pos1,
        page_anchor = page_anchor,
        chapter = chapter,
        pageno = pageno,
        progress = progress,
        context = self:context(text),
    }
end

--[[--
Prose either side of the selection, as one passage.

`getSelectedWordContext` is KOReader's own, already `pcall`-wrapped, and it
handles the crengine quirk that reading text back clears the drawn selection.
--]]
function Ask:context(text)
    local ok, before, after = pcall(function()
        return self.ui.highlight:getSelectedWordContext(CONTEXT_WORDS)
    end)
    if not ok then return nil end

    local parts = {}
    for _, part in ipairs({ before, text, after }) do
        if type(part) == "string" then
            local clean = part:gsub("%s+", " "):gsub("^ ", ""):gsub(" $", "")
            if clean ~= "" then table.insert(parts, clean) end
        end
    end
    if #parts <= 1 then return nil end
    return table.concat(parts, " ")
end

--[[--
Whether two highlight positions are the same place.

A reflowable document's position is an xpointer string, which compares directly.
A paging document's is a table of page and coordinates, and `==` on those asks
whether they are the same object rather than the same place — which they are not,
since KOReader hands the highlight menu a deep copy of the annotation.
--]]
local function same_position(a, b)
    if a == b then return true end
    if type(a) ~= "table" or type(b) ~= "table" then return false end
    return a.page == b.page and a.x == b.x and a.y == b.y
end

--[[--
The annotation this passage already has, if the reader highlighted it before.

`index` is what KOReader passes the highlight-menu button for a saved highlight,
and it is authoritative: it names the row in `annotations` this popup was opened
for. The search is the fallback for a fresh selection, where there is no index
because there is not yet an annotation.
--]]
function Ask:existing_annotation(snapshot, index)
    local annotations = self.ui.annotation.annotations or {}

    if type(index) == "number" then
        local annotation = annotations[index]
        if annotation and annotation.text == snapshot.text then return annotation end
    end

    for _, annotation in ipairs(annotations) do
        if annotation.text == snapshot.text and same_position(annotation.pos0, snapshot.pos0) then
            return annotation
        end
    end
    return nil
end

--[[--
Creates the annotation for a passage that does not have one yet.

Mirrors the item `ReaderHighlight:saveHighlight` builds, rather than reaching
back into `ReaderHighlight.selected_text`, which by now has been cleared.
--]]
function Ask:ensure_annotation(snapshot, index)
    local existing = self:existing_annotation(snapshot, index)
    if existing then return existing end

    local item = {
        page = snapshot.page_anchor,
        pos0 = snapshot.pos0,
        pos1 = snapshot.pos1,
        text = snapshot.text,
        chapter = snapshot.chapter,
        drawer = self.ui.view.highlight.saved_drawer,
        color = self.ui.view.highlight.saved_color,
    }

    local index = self.ui.annotation:addItem(item)
    self.ui.view.footer:maybeUpdateFooter()
    self.ui:handleEvent(Event:new("AnnotationsModified",
        { item, nb_highlights_added = 1, index_modified = index }))
    return item
end

--[[--
Whether an annotation looks like the passage a thread was started on.

A thread remembers its highlight by a content-derived id, which is what makes
export idempotent — but it also means the id moves whenever the highlight does.
KOReader's own boundary controls change `pos0` and the text, so nudging a
highlight by one word used to sever it from its conversation for good.

Containment either way is the test, because that is what an adjustment does: a
highlight extended by a word contains the passage the conversation started on,
and one trimmed by a word is contained by it.

Containment alone is too generous, though. A conversation about a short phrase
would be adopted by any later highlight of a paragraph that happens to include
it, which is worse than failing to repair the link — the conversation is still
reachable from the list either way, but a wrong one attached to a highlight is
a lie. So the two have to be comparable in length as well.

The bound admits a highlight that grew by up to about half again, which covers
adjusting a boundary by a few words, and refuses one that grew several times
over, which is a different selection rather than the same one moved. It is the
looser of the two guards; the one that does the real work is that a conversation
is only ever adopted when its own highlight has gone.
--]]
local SIMILAR_ENOUGH = 0.4

local function looks_like(annotation_text, seed_text)
    if type(annotation_text) ~= "string" or type(seed_text) ~= "string" then return false end
    if annotation_text == "" or seed_text == "" then return false end
    if annotation_text == seed_text then return true end

    local contained = annotation_text:find(seed_text, 1, true) ~= nil
        or seed_text:find(annotation_text, 1, true) ~= nil
    if not contained then return false end

    local shorter = math.min(#annotation_text, #seed_text)
    local longer = math.max(#annotation_text, #seed_text)
    return shorter >= longer * SIMILAR_ENOUGH
end

--[[--
The one annotation that looks like this passage, if exactly one does.

`claimed` holds the ids other threads are already anchored to; an annotation in
that set belongs to a different conversation and is not available to this one.
--]]
function Ask:annotation_like(seed_text, claimed)
    local found
    for _, annotation in ipairs(self.ui.annotation.annotations or {}) do
        local id = annotation.text and annotation.text ~= ""
            and Payload.external_id(annotation, Util.sha256_hex) or nil
        if id and not (claimed and claimed[id]) and looks_like(annotation.text, seed_text) then
            -- Two candidates is no answer: adopting either would be a guess at
            -- which highlight the conversation belongs to.
            if found then return nil end
            found = annotation
        end
    end
    return found
end

--- Points a thread at the annotation it has been rediscovered on, and stores it.
function Ask:relink(thread, annotation)
    thread.highlight_ref = Payload.external_id(annotation, Util.sha256_hex)
    local data = Store.read(self.ui.doc_settings)
    local stored = Store.find_thread_by_id(data, thread.id)
    if stored then
        stored.highlight_ref = thread.highlight_ref
        Store.write(self.ui.doc_settings, data)
    end
end

--[[--
The annotation a thread is anchored to, if it is still there.

A thread stores the id its highlight had, not a reference to it, so this is how
one is found again — including from the conversation list, where there is no
selection to work from. The highlight may have been deleted since; a
conversation outlives its mark, and continuing one is still worth doing.

When the id no longer matches anything, one attempt is made to recognise the
highlight by its text and re-point the thread at it, so a highlight adjusted
after the fact keeps its conversation.
--]]
function Ask:find_annotation(highlight_ref, thread)
    for _, annotation in ipairs(self.ui.annotation.annotations or {}) do
        if annotation.text and annotation.text ~= "" and highlight_ref
            and Payload.external_id(annotation, Util.sha256_hex) == highlight_ref then
            return annotation
        end
    end

    if thread then
        local data = Store.read(self.ui.doc_settings)
        local claimed = {}
        for _, other in ipairs(data.threads or {}) do
            if other.id ~= thread.id and other.highlight_ref then
                claimed[other.highlight_ref] = true
            end
        end

        local candidate = self:annotation_like(thread.seed_text, claimed)
        if candidate then
            self:relink(thread, candidate)
            return candidate
        end
    end
    return nil
end

--[[--
Rebuilds a snapshot from a stored thread.

Everything a follow-up needs was captured when the conversation started: the
passage, where it sits, and the prose around it. The positions come from the
annotation when it is still there, so that asking again can save to its note.
--]]
function Ask:snapshot_for_thread(thread, annotation)
    return {
        text = thread.seed_text or (annotation and annotation.text) or "",
        pos0 = annotation and annotation.pos0,
        pos1 = annotation and annotation.pos1,
        page_anchor = annotation and annotation.page,
        chapter = thread.chapter or (annotation and annotation.chapter),
        progress = thread.progress,
        context = thread.context,
    }
end

--[[--
Opens a stored conversation, from wherever it was chosen.
--]]
function Ask:continue_thread(thread)
    local annotation = self:find_annotation(thread.highlight_ref, thread)
    self:show_thread(self:snapshot_for_thread(thread, annotation), thread, annotation)
end

--[[--
The conversation hanging off one annotation, if it has one with anything in it.
--]]
function Ask:thread_for_annotation(annotation)
    if not annotation or not annotation.text or annotation.text == "" then return nil end
    local data = Store.read(self.ui.doc_settings)

    local id = Payload.external_id(annotation, Util.sha256_hex)
    local thread = Store.find_thread(data, id)

    if not thread then
        -- The same repair from the other direction: a highlight whose bounds
        -- were adjusted has an id no thread knows, but a thread may still
        -- remember its text. Only conversations whose own highlight has gone
        -- are candidates — one that still has its mark is not looking for a
        -- new home, and letting a fresh overlapping highlight adopt it would
        -- attach a conversation to a passage nobody had it about.
        local present = {}
        for _, existing in ipairs(self.ui.annotation.annotations or {}) do
            if existing.text and existing.text ~= "" then
                present[Payload.external_id(existing, Util.sha256_hex)] = true
            end
        end

        local found
        for _, candidate in ipairs(data.threads or {}) do
            if #(candidate.messages or {}) > 0
                and not present[candidate.highlight_ref]
                and looks_like(annotation.text, candidate.seed_text) then
                if found then return nil end
                found = candidate
            end
        end
        if found then
            self:relink(found, annotation)
            return found
        end
        return nil
    end

    if #(thread.messages or {}) > 0 then return thread end
    return nil
end

--[[--
Whether this selection already has a conversation.

Used only to name the button, so it deliberately does not take a full snapshot:
that reads prose out of crengine and clears the drawn selection, which is far
too much work — and too much of a side effect — for deciding a label.
--]]
function Ask:has_thread(highlight, index)
    local annotations = self.ui.annotation.annotations or {}
    local annotation = type(index) == "number" and annotations[index] or nil

    if not annotation then
        local selection = highlight and highlight.selected_text
        if selection and selection.text then
            local text = util.cleanupSelectedText(selection.text)
            for _, candidate in ipairs(annotations) do
                if candidate.text == text and same_position(candidate.pos0, selection.pos0) then
                    annotation = candidate
                    break
                end
            end
        end
    end

    return self:thread_for_annotation(annotation) ~= nil
end

--[[--
The thread already hanging off this passage, if there is one.

Only for a passage that is already a highlight: asking is what creates the
annotation, so a fresh selection has nothing for a thread to be attached to yet.
--]]
function Ask:existing_thread(snapshot, index)
    local annotation = self:existing_annotation(snapshot, index)
    local thread = self:thread_for_annotation(annotation)
    if thread then return thread, annotation end
    return nil
end

--[[--
Entry point from the highlight dialog.

A passage that has been asked about before opens its conversation, rather than
the question box. Reading what was already said is the more likely reason to
come back to a passage, and until now there was no way to do it at all: the
thread was in the sidecar with nothing to read it.
--]]
function Ask:from_selection(highlight, index)
    local snapshot = self:snapshot(highlight)
    if not snapshot then
        UIManager:show(InfoMessage:new{ text = _("Select some text first.") })
        return
    end

    highlight:onClose()

    local thread, annotation = self:existing_thread(snapshot, index)
    if thread then
        self:show_thread(snapshot, thread, annotation, index)
        return
    end

    self:prompt_for_question(snapshot, nil, index)
end

--[[--
Asks for the question, then runs the exchange.
--]]
function Ask:prompt_for_question(snapshot, thread, index)
    local dialog
    dialog = InputDialog:new{
        title = thread and _("Ask a follow-up") or _("Ask Marginalia"),
        description = snapshot.text,
        description_face = nil,
        input = "",
        input_hint = _("What do you want to know about this passage?"),
        allow_newline = false,
        buttons = {{
            {
                text = _("Cancel"),
                id = "close",
                callback = function() UIManager:close(dialog) end,
            },
            {
                text = _("Ask"),
                is_enter_default = true,
                callback = function()
                    local question = (dialog:getInputText() or ""):gsub("^%s+", ""):gsub("%s+$", "")
                    if question == "" then return end
                    UIManager:close(dialog)
                    self:run(snapshot, thread, question, index)
                end,
            },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

--[[--
Sends one question and shows the answer.

The request blocks, so it runs inside a Trapper subprocess: the UI keeps
painting and the reader can tap to give up on a model that is taking too long.
--]]
function Ask:run(snapshot, thread, question, index)
    NetworkMgr:runWhenOnline(function()
        Trapper:wrap(function()
            -- Continuing a conversation must not mint a second highlight for a
            -- passage that already has one — and when it is reached from the
            -- conversation list there is no selection to make one from anyway.
            local annotation, highlight_ref
            if thread then
                annotation = self:find_annotation(thread.highlight_ref, thread)
                highlight_ref = thread.highlight_ref
            else
                annotation = self:ensure_annotation(snapshot, index)
                highlight_ref = Payload.external_id(annotation, Util.sha256_hex)
            end

            -- Folding happens before anything is read out of the store, and its
            -- result is picked up by the read below. Everything this plugin
            -- keeps lives under one sidecar key, so a table read before the fold
            -- and written after it would put the old digest straight back — and
            -- would restore the thread's old `summarized_count` with it, so the
            -- same turns would be folded again on the next question.
            local pending_id = thread and thread.id
            if pending_id then self.memory:fold(pending_id) end

            local data = Store.read(self.ui.doc_settings)

            -- Reacquired by id rather than carried in: the thread handed to a
            -- follow-up came from the viewer and predates the fold.
            thread = (pending_id and Store.find_thread_by_id(data, pending_id))
                or Store.find_thread(data, highlight_ref)
                or Store.new_thread{
                    highlight_ref = highlight_ref,
                    title = Prompt.title_from_seed(snapshot.text),
                    seed_text = snapshot.text,
                    context = snapshot.context,
                    chapter = snapshot.chapter,
                    progress = snapshot.progress,
                }

            local history = Store.history(thread)
            table.insert(history, { role = "user", content = question })

            local book = self:book_metadata()
            local memory = data.memory and data.memory.summary

            -- The digest joins the collision check. It is the most dangerous of
            -- the fenced bodies: unlike a passage, it persists into every later
            -- prompt, so a delimiter that got into it would keep getting a turn.
            local fence, fence_error = Prompt.fence_for({
                snapshot.text, snapshot.context, memory,
                book.title, book.authors, book.description,
            }, Util.random_hex)
            if not fence then
                UIManager:show(InfoMessage:new{ text = fence_error })
                return
            end

            local messages = Prompt.messages({
                book = book,
                chapter = snapshot.chapter,
                progress = snapshot.progress,
                passage = snapshot.text,
                context = snapshot.context,
                memory = memory,
                spoiler_guard = self.settings.spoiler_guard,
                fence = fence,
            }, history)

            local endpoint = self.settings.endpoint
            local cafile = self.cafile
            local version = self.plugin_version

            local completed, result = Trapper:dismissableRunInSubprocess(function()
                return Relay.post(endpoint, messages, cafile, version)
            end, _("Asking Marginalia…"))

            if not completed then
                logger.dbg("marginalia: request dismissed by the reader")
                return
            end

            if type(result) ~= "table" or not result.ok then
                local message = type(result) == "table" and result.error
                    or _("Marginalia could not answer that.")
                UIManager:show(InfoMessage:new{ text = message, timeout = 8 })
                return
            end

            -- Only recorded once there is an answer: a question that failed to
            -- send is not part of the conversation, and keeping it would make
            -- the next request replay it with no reply after it.
            Store.append_message(thread, "user", question)
            Store.append_message(thread, "assistant", result.text)
            Store.upsert_thread(data, thread)
            Store.write(self.ui.doc_settings, data)

            self:show_thread(snapshot, thread, annotation, index)
        end)
    end)
end

function Ask:book_metadata()
    local props = self.ui.doc_props or {}
    return {
        title = props.display_title or props.title,
        authors = props.authors,
        language = props.language,
        description = props.description,
    }
end

--[[--
Shows a conversation, with the ways out of it.

The whole thread, not only the newest reply. A follow-up is asked *because* of
what was said before, and an answer shown on its own leaves the reader holding
half of it.
--]]
function Ask:show_thread(snapshot, thread, annotation, index)
    local viewer
    viewer = TextViewer:new{
        title = thread.title,
        text = View.thread_document(thread),
        text_type = "lookup",
        buttons_table = {{
            {
                text = _("Ask a follow-up"),
                callback = function()
                    UIManager:close(viewer)
                    self:prompt_for_question(snapshot, thread, index)
                end,
            },
            {
                text = _("Save to note"),
                -- A conversation outlives its highlight; there may be no note
                -- left to write into.
                enabled = annotation ~= nil,
                callback = function()
                    self:save_to_note(annotation, thread)
                    UIManager:close(viewer)
                end,
            },
        }, {
            {
                text = _("Close"),
                callback = function() UIManager:close(viewer) end,
            },
        }},
    }
    UIManager:show(viewer)
end

--[[--
Writes the exchange into the highlight's own KOReader note.

The thread is already in the sidecar, but a note is what shows up in the
bookmark list and in every other exporter, so this is how the conversation
becomes visible to the rest of KOReader.
--]]
function Ask:save_to_note(annotation, thread)
    annotation.note = View.transcript(thread)
    annotation.note_format = nil
    annotation.datetime_updated = Util.now_local()

    self.ui:handleEvent(Event:new("AnnotationsModified", { annotation }))
    self.ui.doc_settings:flush()

    UIManager:show(InfoMessage:new{
        text = _("Saved to this highlight's note."),
        timeout = 2,
    })
end

return Ask
