type Props = { className?: string }

const base = 'h-5 w-5'

function Svg({ className = base, children }: Props & { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  )
}

export function BackIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <path d="M19 12H5m6-6-6 6 6 6" />
    </Svg>
  )
}

export function GearIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </Svg>
  )
}

export function ChatIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <path d="M21 12a8 8 0 0 1-8 8H6l-4 3 1.4-5.1A9 9 0 1 1 21 12Z" />
    </Svg>
  )
}

export function ListIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
    </Svg>
  )
}

export function TypeIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <path d="M4 7V4h16v3M9 20h6M12 4v16" />
    </Svg>
  )
}

export function PlusIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function MoreIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function TrashIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    </Svg>
  )
}

export function CloseIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  )
}

export function SendIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <path d="M12 19V5m-6 6 6-6 6 6" />
    </Svg>
  )
}

export function ShareIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <path d="M12 15V3m-4 4 4-4 4 4M7 10H5v11h14V10h-2" />
    </Svg>
  )
}

export function LinkIcon({ className }: Props) {
  return (
    <Svg className={className}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Svg>
  )
}
