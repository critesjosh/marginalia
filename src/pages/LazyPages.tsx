import { lazy } from 'react'

export const ReaderPage = lazy(() => import('./ReaderPage'))
export const ChatsPage = lazy(() => import('./ChatsPage'))
export const SettingsPage = lazy(() => import('./SettingsPage'))
export const PrivacyPage = lazy(() => import('./PrivacyPage'))
export const HelpPage = lazy(() => import('./HelpPage'))
// Reached only from a share sheet, so it never needs to be in the first load.
export const AddSharedPage = lazy(() => import('./AddSharedPage'))
