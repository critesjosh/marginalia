import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, deleteConversation, getSettings } from '../db/db'
import { DEFAULT_SETTINGS } from '../db/types'
import ChatSheet from '../components/ChatSheet'
import MemoryPanel from '../components/MemoryPanel'
import Passage from '../components/Passage'
import { BackIcon, TrashIcon } from '../components/Icons'
import { iconButton } from '../components/ui'

type Tab = 'chats' | 'highlights' | 'memory'

export default function ChatsPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const [tab, setTab] = useState<Tab>('chats')
  const [chatId, setChatId] = useState<string>()

  const book = useLiveQuery(() => (bookId ? db.books.get(bookId) : undefined), [bookId])
  const conversations = useLiveQuery(
    () =>
      bookId ? db.conversations.where('bookId').equals(bookId).reverse().sortBy('updatedAt') : [],
    [bookId],
  )
  const highlights = useLiveQuery(
    () =>
      bookId ? db.highlights.where('bookId').equals(bookId).reverse().sortBy('createdAt') : [],
    [bookId],
  )
  const memory = useLiveQuery(() => (bookId ? db.bookMemory.get(bookId) : undefined), [bookId])
  const settings = useLiveQuery(() => getSettings(), []) ?? DEFAULT_SETTINGS
  const readerAvailable = Boolean(book && !book.archivedAt)

  return (
    <div className="paper-grain min-h-full bg-paper text-ink">
      <header className="pt-safe sticky top-0 z-10 border-b border-rule bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-2 pt-2 pb-1">
          <Link
            to={bookId && readerAvailable ? `/book/${bookId}` : '/'}
            aria-label={readerAvailable ? 'Back to reader' : 'Back to library'}
            className={iconButton}
          >
            <BackIcon />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Threads from this book</p>
            <h1 className="truncate font-book text-heading font-medium">{book?.title ?? 'Book'}</h1>
          </div>
        </div>

        <div role="tablist" className="mx-auto flex max-w-2xl gap-1 overflow-x-auto px-3">
          <TabButton active={tab === 'chats'} onClick={() => setTab('chats')}>
            Threads {conversations?.length ? `(${conversations.length})` : ''}
          </TabButton>
          <TabButton active={tab === 'highlights'} onClick={() => setTab('highlights')}>
            Highlights {highlights?.length ? `(${highlights.length})` : ''}
          </TabButton>
          <TabButton active={tab === 'memory'} onClick={() => setTab('memory')}>
            Memory
          </TabButton>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-6">
        {tab === 'chats' && (
          <>
            {conversations?.length === 0 && (
              <Empty>
                Select a line while reading and choose “Ask about this” to start a thread.
              </Empty>
            )}

            <ul className="space-y-3">
              {conversations?.map((conversation) => (
                <li
                  key={conversation.id}
                  className="flex items-start gap-2 rounded-md border border-rule bg-paper-leaf p-4"
                >
                  <button
                    onClick={() => setChatId(conversation.id)}
                    aria-label={`Follow this thread: ${conversation.title}`}
                    className="min-w-0 flex-1 rounded-md text-left"
                  >
                    <p className="line-clamp-2 font-book text-book-title font-medium">
                      {conversation.title}
                    </p>
                    <p className="mt-1 font-ui text-meta text-ink-faint">
                      {conversation.chapter ? `${conversation.chapter} · ` : ''}
                      {new Date(conversation.updatedAt).toLocaleDateString()}
                    </p>
                  </button>
                  <button
                    onClick={() => void deleteConversation(conversation.id)}
                    aria-label={`Delete ${conversation.title}`}
                    className={`${iconButton} -mt-2 -mr-2`}
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {tab === 'highlights' && (
          <>
            {highlights?.length === 0 && <Empty>No highlights yet.</Empty>}
            <ul className="space-y-3">
              {highlights?.map((highlight) => (
                <li key={highlight.id} className="flex items-start gap-1">
                  <Link
                    to={`/book/${bookId}?cfi=${encodeURIComponent(highlight.cfiRange)}`}
                    className="min-w-0 flex-1 rounded-md"
                  >
                    <Passage clamp cite={highlight.chapter}>
                      {highlight.text}
                    </Passage>
                  </Link>
                  <button
                    onClick={() => void db.highlights.delete(highlight.id)}
                    aria-label="Delete highlight"
                    className={iconButton}
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {tab === 'memory' && (
          <MemoryPanel
            // Keyed so an unsaved draft cannot follow the reader to another
            // book: this page is reused across `bookId`, and Save writes to
            // whichever book is current.
            key={bookId}
            book={book}
            memory={memory}
            latest={conversations?.[0]}
            settings={settings}
          />
        )}
      </main>

      {chatId && <ChatSheet conversationId={chatId} onClose={() => setChatId(undefined)} />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`min-h-tap shrink-0 border-b-2 px-3 font-ui text-label font-medium transition-colors duration-150 ${
        active ? 'border-moss text-ink' : 'border-transparent text-ink-soft hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="mx-auto mt-16 max-w-xs text-center font-ui text-body text-ink-soft">{children}</p>
  )
}
