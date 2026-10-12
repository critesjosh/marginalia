import { useEffect, useState } from 'react'
import { db } from '../db/db'
import { BUILD_ID } from './buildInfo'
import {
  describeClientHints,
  issueUrl,
  readDiagnostics,
  type ClientHints,
  type DiagnosticContext,
} from './diagnostics'

const MB = 1024 * 1024

/**
 * A new-issue link prefilled with the diagnostic log, built ahead of the click:
 * iOS Safari blocks a window opened after an await, so the link has to be ready.
 */
export function useIssueUrl(issuesUrl: string): string {
  const [url, setUrl] = useState(`${issuesUrl}/new`)

  useEffect(() => {
    let canceled = false
    void collectContext()
      .then((context) => {
        if (!canceled) setUrl(issueUrl(issuesUrl, context, readDiagnostics()))
      })
      .catch(() => undefined)
    return () => {
      canceled = true
    }
  }, [issuesUrl])

  return url
}

async function collectContext(): Promise<DiagnosticContext> {
  const storage = navigator.storage as StorageManager | undefined
  const userAgentData = (
    navigator as { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<ClientHints> } }
  ).userAgentData
  const [hints, persisted, estimate, total, removed, missing] = await Promise.all([
    userAgentData
      ?.getHighEntropyValues(['platformVersion', 'fullVersionList'])
      .catch(() => undefined),
    storage?.persisted?.().catch(() => undefined),
    storage?.estimate?.().catch(() => undefined),
    db.books.count(),
    db.books.where('archivedAt').above(0).count(),
    db.books.filter((book) => Boolean(book.missingFileAt)).count(),
  ])
  return {
    build: BUILD_ID,
    browser: hints && describeClientHints(hints),
    userAgent: navigator.userAgent,
    standalone:
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as { standalone?: boolean }).standalone === true,
    persisted,
    usageMb: estimate?.usage === undefined ? undefined : Math.round(estimate.usage / MB),
    quotaMb: estimate?.quota === undefined ? undefined : Math.round(estimate.quota / MB),
    books: { total, removed, missing },
  }
}
