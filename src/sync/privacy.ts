import type { Settings } from '../db/types'
import {
  CONSENT_VERSION,
  type ConsentChangeCategory,
  type PrivacyCategory,
  type PrivacySnapshot,
  type SyncConsentV1,
  type SyncPreferenceKey,
} from './types'

export const DEFAULT_SYNC_CONSENT: SyncConsentV1 = {
  consentVersion: CONSENT_VERSION,
  consentUpdatedAt: new Date(0).toISOString(),
  syncEnabled: false,
  shareBookMetadata: false,
  shareHighlightText: false,
  shareHighlightNotes: false,
  shareConversationText: false,
  shareAssistantText: false,
  shareBookMemory: false,
  shareSurroundingContext: false,
}

export const CONTENT_CONSENT_KEYS = [
  'shareBookMetadata',
  'shareHighlightText',
  'shareHighlightNotes',
  'shareConversationText',
  'shareAssistantText',
  'shareBookMemory',
  'shareSurroundingContext',
] as const satisfies readonly SyncPreferenceKey[]

const CATEGORY_BY_KEY: Record<(typeof CONTENT_CONSENT_KEYS)[number], PrivacyCategory> = {
  shareBookMetadata: 'bookMetadata',
  shareHighlightText: 'highlightText',
  shareHighlightNotes: 'highlightNotes',
  shareConversationText: 'conversationText',
  shareAssistantText: 'assistantText',
  shareBookMemory: 'bookMemory',
  shareSurroundingContext: 'surroundingContext',
}

export function consentFromSettings(settings: Settings): SyncConsentV1 {
  return {
    consentVersion: CONSENT_VERSION,
    consentUpdatedAt: settings.consentUpdatedAt,
    syncEnabled: settings.syncEnabled,
    shareBookMetadata: settings.shareBookMetadata,
    shareHighlightText: settings.shareHighlightText,
    shareHighlightNotes: settings.shareHighlightNotes,
    shareConversationText: settings.shareConversationText,
    shareAssistantText: settings.shareAssistantText,
    shareBookMemory: settings.shareBookMemory,
    shareSurroundingContext: settings.shareSurroundingContext,
  }
}

export function includedCategories(consent: SyncConsentV1): PrivacyCategory[] {
  if (!consent.syncEnabled) return []
  return CONTENT_CONSENT_KEYS.filter((key) => consent[key]).map((key) => CATEGORY_BY_KEY[key])
}

export function privacySnapshot(
  consent: SyncConsentV1,
  used: readonly PrivacyCategory[],
): PrivacySnapshot {
  const allowed = new Set(includedCategories(consent))
  return {
    consentVersion: CONSENT_VERSION,
    included: used.filter((category) => allowed.has(category)),
  }
}

export function revokedCategories(
  previous: SyncConsentV1,
  next: SyncConsentV1,
): PrivacyCategory[] {
  return CONTENT_CONSENT_KEYS.filter((key) => previous[key] && !next[key]).map(
    (key) => CATEGORY_BY_KEY[key],
  )
}

export function changedContentConsent(
  previous: SyncConsentV1,
  next: SyncConsentV1,
): { category: ConsentChangeCategory; enabled: boolean }[] {
  return CONTENT_CONSENT_KEYS.filter((key) => previous[key] !== next[key]).map((key) => ({
    category: CATEGORY_BY_KEY[key],
    enabled: next[key],
  }))
}
