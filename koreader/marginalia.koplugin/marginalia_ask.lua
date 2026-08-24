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
The thread already hanging off this passage, if there is one.

Only for a passage that is already a highlight: asking is what creates the
annotation, so a fresh selection has nothing for a thread to be attached to yet.
--]]
function Ask:existing_thread(snapshot, index)
    local annotation = self:existing_annotation(snapshot, index)
    if not annotation then return nil end

    local data = Store.read(self.ui.doc_settings)
    local thread = Store.find_thread(data, Payload.external_id(annotation, Util.sha256_hex))
    if thread and #(thread.messages or {}) > 0 then
        return thread, annotation
    end
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
            local annotation = self:ensure_annotation(snapshot, index)
            local highlight_ref = Payload.external_id(annotation, Util.sha256_hex)

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
