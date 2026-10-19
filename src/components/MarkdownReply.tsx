import Markdown from 'react-markdown'

/** Render model text without raw HTML or remote images. */
export default function MarkdownReply({ children }: { children: string }) {
  return (
    <div className="markdown-reply mt-0.5 min-w-0 flex-1 font-ui text-body">
      <Markdown
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          // Keep the description without contacting an image host from a reply.
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {children}
      </Markdown>
    </div>
  )
}
