const REPO_URL = 'https://github.com/critesjosh/marginalia'

export interface BuildInfo {
  label: string
  url?: string
}

/** Describes the build for display: `a1b2c3d · 2026-10-09`, or `dev` when unknown. */
export function describeBuild(commit: string | undefined, builtAt: string | undefined): BuildInfo {
  const date = builtAt?.slice(0, 10)
  if (!commit) return { label: date ? `dev · ${date}` : 'dev' }
  const sha = commit.replace(/-dirty$/, '')
  return {
    label: date ? `${commit} · ${date}` : commit,
    url: `${REPO_URL}/commit/${sha}`,
  }
}

/** The exact build, for logs: `a1b2c3d built 2026-10-09T14:03:12.345Z`. */
export function buildId(commit: string | undefined, builtAt: string | undefined): string {
  return `${commit || 'dev'} built ${builtAt ?? 'unknown'}`
}

const COMMIT = import.meta.env.APP_COMMIT as string | undefined
const BUILT_AT = import.meta.env.APP_BUILT_AT as string | undefined

export const BUILD: BuildInfo = describeBuild(COMMIT, BUILT_AT)
export const BUILD_ID = buildId(COMMIT, BUILT_AT)
