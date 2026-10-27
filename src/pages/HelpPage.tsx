import { useEffect, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { BackIcon } from '../components/Icons'
import { iconButton } from '../components/ui'
import { BRIDGE_DOCS } from '../lib/localAgent'

/**
 * Everything Rami does, in one place to come back to. The one-time hints point
 * at single features as they first apply; this page is where all of them stay.
 * Keep it in step with the features it names.
 */
export default function HelpPage() {
  const navigate = useNavigate()
  const location = useLocation()
  // Reached from the library and from Settings, so go back to whichever it was.
  const back = () => (location.key === 'default' ? navigate('/') : navigate(-1))

  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }, [location.hash])

  return (
    <div className="paper-grain min-h-full bg-paper text-ink">
      <header className="pt-safe sticky top-0 z-10 border-b border-rule bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-2">
          <button onClick={back} aria-label="Back" className={iconButton}>
            <BackIcon />
          </button>
          <h1 className="font-book text-heading font-medium">How Rami works</h1>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-8 px-4 py-8 font-ui text-body text-ink-soft [&_a]:text-moss [&_a]:underline [&_a]:underline-offset-2">
        <Topic title="Ask about a passage">
          <li>Open a book, select a line, and choose “Ask about this”.</li>
          <li>
            Rami reads the passage with the text around it, your chapter, its memory of the book and
            your standing instructions, then replies. Keep asking to follow the thread.
          </li>
          <li>
            Every passage you ask about stays highlighted. Tap it to reopen its thread, or open
            Threads from the toolbar to see them all.
          </li>
        </Topic>

        <Topic title="Reading">
          <li>
            Tap the right side of the page to turn forward, the left to turn back, and the middle to
            show or hide the toolbar. With a mouse, point above or below the page to show it. On a
            keyboard, use the arrow keys, and Escape for the toolbar.
          </li>
          <li>The toolbar opens the table of contents and the text size and page color.</li>
          <li>
            Rami keeps your place in every book. Choose a reading font and highlight color in{' '}
            <Link to="/settings">Settings</Link>.
          </li>
        </Topic>

        <Topic title="Rami’s memory">
          <li>
            After a few exchanges, Rami writes notes on each book from your threads and brings them
            into every new thread.
          </li>
          <li>
            Read, edit or clear them on the book’s Memory tab, under Threads. The same tab holds
            instructions for that book alone.
          </li>
          <li>
            Standing instructions in <Link to="/settings">Settings</Link> apply to every book: what
            to call you, how to answer, anything Rami should always do. Turn on Brief replies there
            for a few sentences instead of a few paragraphs.
          </li>
        </Topic>

        <Topic title="Use your own local agent" id="local-agent">
          <li>
            On a computer, install Node.js 24 and sign in to Claude Code or Codex. Download or clone
            the{' '}
            <a href="https://github.com/critesjosh/marginalia" target="_blank" rel="noreferrer">
              Rami repository
            </a>
            , then run <code>npm ci</code> in its folder.
          </li>
          <li>
            If you want the agent to use search or other tools, set up those MCP servers in your
            agent first. Check their names with <code>claude mcp list</code> or{' '}
            <code>codex mcp list</code>. A server can include file editing tools as well as search;
            allow only servers whose full capabilities you trust.
          </li>
          <li>
            Start the bridge from the Rami folder with{' '}
            <code>npm run agent-bridge -- --agent claude --mcp tavily</code>. Replace the agent and
            server names with yours; omit <code>--mcp</code> to allow no MCP tools. Add{' '}
            <code>--model &lt;model name&gt;</code> to choose a model, or{' '}
            <code>--mcp-tools miyo:search,miyo:read_file</code> to allow only some tools of a
            server. Keep this terminal open while reading.
          </li>
          <li>
            In <Link to="/settings">Settings → Local agent</Link>, paste the pairing token printed
            on the first run and choose Connect. Settings shows the connected agent and allowed
            servers. If the bridge stops, paired chat shows an error until you start it again.
          </li>
          <li>
            This works in Chrome, Edge and Firefox on the same computer as the bridge. It does not
            work on phones or in Safari. Your chats go to your agent provider and any MCP servers
            you allow. See the{' '}
            <a href={BRIDGE_DOCS} target="_blank" rel="noreferrer">
              full setup and troubleshooting guide
            </a>
            .
          </li>
        </Topic>

        <Topic title="Sharing">
          <li>A passage: select it and choose “Share”.</li>
          <li>
            A thread: the buttons below its messages share it, or publish a link anyone can read for
            a year.
          </li>
          <li>
            A Project Gutenberg book: tap ⋯ beside it on the shelf and choose “Share book” to send
            an invitation that adds it to someone else’s library.
          </li>
        </Topic>

        <Topic title="Your library">
          <li>“Add book” searches Project Gutenberg or opens an EPUB from your device.</li>
          <li>
            Tap ⋯ beside a book to change its cover or remove it. Removing can keep your highlights,
            threads and memory, or delete them.
          </li>
          <li>
            Add Rami to your home screen to open it like an app and read offline. Asking Rami needs
            a connection.
          </li>
        </Topic>

        <Topic title="Your data">
          <li>
            Books, highlights, threads and notes stay in this browser. Export them from{' '}
            <Link to="/settings">Settings</Link>, where you can also import highlights from the
            KOReader plugin.
          </li>
          <li>
            The <Link to="/privacy">privacy policy</Link> says exactly what leaves your device.
          </li>
        </Topic>
      </main>
    </div>
  )
}

function Topic({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="mb-3 font-book text-heading font-medium text-ink">{title}</h2>
      <ul className="list-disc space-y-2 pl-5 marker:text-rubric">{children}</ul>
    </section>
  )
}
