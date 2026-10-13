import { useSyncExternalStore, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BackIcon } from '../components/Icons'
import { iconButton } from '../components/ui'
import { telemetry } from '../lib/telemetry'

const CONTACT_EMAIL = 'rami@agenticpossible.com'
const UPDATED = '12 October 2026'

/**
 * The privacy policy. Every statement here describes what the code does;
 * change it alongside any change to what leaves the device (docs/telemetry.md,
 * docs/operations.md).
 */
export default function PrivacyPage() {
  const preference = useSyncExternalStore(telemetry.subscribe, telemetry.preference)
  const configured = useSyncExternalStore(telemetry.subscribe, telemetry.configured)

  return (
    <div className="paper-grain min-h-full bg-paper text-ink">
      <header className="pt-safe sticky top-0 z-10 border-b border-rule bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-2">
          <Link to="/settings" aria-label="Back to settings" className={iconButton}>
            <BackIcon />
          </Link>
          <h1 className="font-book text-heading font-medium">Privacy policy</h1>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-8 px-4 py-8 font-ui text-body text-ink-soft [&_a]:text-moss [&_a]:underline [&_a]:underline-offset-2">
        <p className="text-meta text-ink-faint">Last updated {UPDATED}</p>

        <Section title="The short version">
          <p>
            Your books, highlights, notes and conversations stay in this browser. Rami has no
            accounts and never uploads your EPUB files. Text leaves your device only when you ask
            Rami about a passage, publish a thread or share a book, or choose to send a report.
            Anonymous usage counts are sent only where the law allows them by default or where you
            agree, and never include what you read or write.
          </p>
        </Section>

        <Section title="Who runs Rami">
          <p>
            Rami is an independent project run by its maintainer, who is responsible for the data
            described here. Write to <Email /> with any question or request.
          </p>
        </Section>

        <Section title="Stored only on your device">
          <p>
            Books, covers, reading positions, highlights, conversations, Rami’s notes on each book,
            your standing instructions and your settings are kept in this browser’s storage. They
            are not sent to us. You can export them from Settings, and clearing this site’s data in
            your browser removes them completely.
          </p>
          <p>
            Rami also keeps a short log of lost files and app updates on the device. It names no
            books or notes and is sent only if you open a GitHub issue from Settings and submit it
            yourself, on GitHub, under GitHub’s terms.
          </p>
        </Section>

        <Section title="When you ask Rami about a passage">
          <p>
            Rami sends the book’s title and author, the chapter and your rough position, the passage
            you selected and the text around it, the conversation so far, Rami’s notes on the book,
            and your standing instructions. They go through our server to{' '}
            <a href="https://openrouter.ai/privacy" target="_blank" rel="noreferrer">
              OpenRouter
            </a>
            , which passes them to a model provider (Cloudflare first, others if it is unavailable)
            to write the reply. Rami does the same, in the background, to update its notes on a book
            after a conversation. Our server does not store or log these messages. OpenRouter and
            the provider handle them under their own policies.
          </p>
          <p>
            The KOReader plugin sends the same kind of request, from your e-reader, to the same
            server.
          </p>
        </Section>

        <Section title="Finding books and covers">
          <p>
            Searching the catalog sends your search words through our server to Project Gutenberg,
            and adding a book downloads it the same way. Finding a cover sends the book’s title and
            author to Open Library. Our server caches search results for up to an hour, and cover
            searches for up to a day, by the words searched, not by who searched.
          </p>
        </Section>

        <Section title="Threads and books you publish">
          <p>
            Publishing a thread stores a copy of it at an unlisted link. Sharing a book stores its
            title, author, Project Gutenberg number and a re-encoded cover. Anyone with the link can
            see what it holds. Each stays for a year after you last publish it, unless you remove it
            sooner from the thread or the book’s Share dialog, or ask us to.
          </p>
          <p>
            Both dialogs load{' '}
            <a
              href="https://www.cloudflare.com/turnstile-privacy-policy/"
              target="_blank"
              rel="noreferrer"
            >
              Cloudflare Turnstile
            </a>{' '}
            to check that a person, not a bot, is publishing. Turnstile loads nowhere else.
          </p>
        </Section>

        <Section title="Anonymous usage data">
          <p>
            Rami can count what readers do and where it breaks, so we can fix it: for example, that
            a book was opened, a passage was selected, a chat reply failed with a network error, or
            which app version was running. Each count carries only fixed values like these, your
            browser family, and whether you use touch or a mouse. It never includes book titles,
            text, highlights, notes, chats, links, or error messages. There are no cookies. The only
            identifier is random, kept in this tab while it is open so counts from one sitting can
            be grouped, and deleted when you close the tab or turn usage data off, so counts cannot
            be tied to you or to each other across visits.
          </p>
          <p>
            Counts go first to our server, which checks them against the same fixed list and passes
            them on to{' '}
            <a href="https://posthog.com/privacy" target="_blank" rel="noreferrer">
              PostHog
            </a>
            , our analytics processor, hosted in the EU. PostHog never receives your IP address or
            any details of your browser beyond the family named above. Counts are kept for up to 12
            months.
          </p>
          <p>
            In the EU, the EEA and Switzerland, or if we can’t tell where you are, Rami asks first
            and sends nothing unless you agree. Elsewhere, including the UK, it is on by default and
            Rami tells you so the first time you visit. If your browser sends Global Privacy Control
            or Do Not Track, it stays off unless you turn it on yourself in Settings. To find which
            rule applies, our server reads the country Cloudflare reports for your connection and
            forgets it at once.
          </p>
          <p className="rounded-md border border-rule bg-paper-leaf p-3 text-meta">
            {configured
              ? `On this device, usage data is ${preference === 'on' ? 'on' : 'off'}. `
              : 'This copy of Rami sends no usage data. '}
            You can change it any time in <Link to="/settings">Settings</Link>.
          </p>
        </Section>

        <Section title="Reports you send">
          <p>
            Report a problem sends the note you write, with email addresses, links and long numbers
            removed, plus the app version, your browser family and details of the last error (its
            type and reference code, never its message). It goes to PostHog even if usage data is
            off, because you chose to send it. Reports are kept for up to 12 months. To have one
            deleted, write to us with its reference code.
          </p>
        </Section>

        <Section title="Hosting">
          <p>
            Rami runs on Cloudflare, which processes your IP address to deliver the site and protect
            it from abuse. Our server keeps IP addresses in memory for a few minutes to limit
            repeated requests, and logs only which kind of request it served, its status and how
            long it took. It never logs messages, links or IP addresses.
          </p>
        </Section>

        <Section title="Legal basis">
          <p>
            Under the GDPR and UK GDPR, we rely on providing the service you ask for (chat, search,
            publishing, reports) and on our legitimate interest in keeping Rami working and safe
            (hosting, abuse limits, and usage counts where they are on by default). Where we ask
            first, we rely on your consent, which you can withdraw in Settings.
          </p>
        </Section>

        <Section title="Transfers">
          <p>
            Cloudflare, OpenRouter and the model providers may process data outside your country,
            including in the United States. PostHog stores usage data in the EU. Where data leaves
            the UK or EEA, our providers use safeguards such as the EU Standard Contractual Clauses
            or the EU-US Data Privacy Framework.
          </p>
        </Section>

        <Section title="Your choices and rights">
          <p>
            Most of your data never reaches us, so you control it directly: export or delete it in
            Rami, or clear the site’s data. You can turn usage data off in Settings and remove
            anything you published. Where data protection law applies, you may also ask to access,
            correct or delete data we hold, or object to how we use it, by writing to <Email />.
            Because usage counts carry no lasting identifier, we usually cannot find a particular
            person’s counts. You can complain to your local data protection authority, such as the
            ICO in the UK.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            If what Rami collects changes, we will update this page and its date before the change
            takes effect.
          </p>
        </Section>
      </main>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-book text-heading font-medium text-ink">{title}</h2>
      {children}
    </section>
  )
}

function Email() {
  return <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
}
