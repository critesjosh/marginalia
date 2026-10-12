# Rami design system

Rami is the PWA's visual language and voice. Read this before changing UI in
`src/`. The tokens live in `src/index.css`; shared components live in
`src/components/` (`BookCover`, `Ribbon`, `Passage`, `Wordmark`, `Mark`,
`Ornament`) and
shared control classes in `src/components/ui.ts`.

_Rami_ is Latin and Italian for branches. A passage is the trunk; each question
grows a branch. The interface should feel like an old, well-loved book on an
evening with time to spare: warm paper, iron-gall ink, cloth and gilt, nothing
shouting.

## The mark

The logo is the branching r: the r of EB Garamond whose arm grows into a stem
and two leaves, a letter of the book becoming something alive. Its outlines live
in `src/components/logoPaths.ts`.

- `Wordmark` (moss r, ink “ami”) where there is room for the name: once per
  screen, 24 to 28px tall in headers, 64px or more on a splash. It follows the
  theme through `--moss` and `--ink`; `mono` sets it all in ink.
- `Mark` (the r alone, one color) where the name won't fit: beside Rami's
  replies and in loading states. Pass `decorative` when the name is visible.
- The wordmark is always lowercase and always drawn, never retyped in a font. In
  sentences the product is “Rami”.
- Clear space is the height of the “a”; minimum size is 20px tall for the
  wordmark and 16px for the mark.
- App icons (`public/favicon.svg`, `icon-*.png`, `apple-touch-icon.png`) are
  the paper-leaf mark on moss. The maskable and Apple icons use the full-bleed
  square so the platform can round it.

## Spirit

- **Curiosity first.** The interface invites the next question rather than
  closing the last one.
- **Discovery, not answers.** Replies open the text up and end by leaving
  somewhere to go next, never with a verdict.
- **Dialogue.** The reader and the book are the two voices; Rami helps them talk.
- **Unfolding.** Reveal things as they are needed: the selection bar rises on
  selection, chrome appears on tap and leaves when reading.
- **Investigation.** Every thread carries its passage, every passage its chapter
  and place.

## Principles

- **Simple.** One primary action per screen. A control not needed while reading
  is not on the page.
- **Comfortable.** Generous leading, a reading measure of 34em, 44px targets, no
  pure white or pure black.
- **Familiar.** Borrow from the printed book: running heads, rubricated labels,
  fleurons, clothbound covers, a ribbon for your place.
- **Warm.** Every neutral leans brown. Shadows are sepia, never gray or blue.
  Motion is slow and settles; nothing bounces.

## Voice

- Speak like a curious, well-read friend. Second person, sentence case, plain
  words.
- Prefer _follow_, _wander_, _trace_, _open_, _thread_, _wonder_, _return_.
  Avoid _query_, _prompt_, _generate_, _answer_, _quiz_, _AI_.
- Reference copy: “Ask about this” (selection bar), “Pick up where you left off”,
  “Follow this thread”, “Threads from this book”, “What caught your eye?” (empty
  composer), “Every book starts somewhere. Add one to begin.” (empty library).
- Rami's replies are prose in the conversation voice (Alegreya Sans), not lists
  or headings, unless the reader asks. A reply may close with one open question
  or one pointer to another passage.
- Greet by the hour (“A good evening for reading”), never with exclamation marks.
- Use real typography in UI copy: curly quotes, the ellipsis character, and an
  unspaced em dash.
- No emoji in the interface; the branching r is the mark everywhere. 🌿 stands
  in for the brand only where an image can't go, such as plain-text bios.

## Color

Two themes: **Paper** (day) and **Lamplight** (night, dark leather and
candle-lit paper, not gray). Screens outside the reader always use Paper,
whatever the system color scheme. The reader sets `data-theme` from its page color (`paper`, `sepia` or
`lamplight`), so its header, sheets and dialogs match the page. Sepia is
reader-only.

Use the token utilities, never raw hex values in components:

| Token                          | Tailwind          | Use                                                           |
| ------------------------------ | ----------------- | ------------------------------------------------------------- |
| `paper`                        | `bg-paper`        | Ground of every page                                          |
| `paper-leaf`                   | `bg-paper-leaf`   | Raised cards, sheets, composer                                |
| `paper-sunk`                   | `bg-paper-sunk`   | Wells, passages, hover wash                                   |
| `ink`, `ink-soft`, `ink-faint` | `text-ink` …      | Text; secondary; timestamps, counts, placeholders             |
| `moss`, `moss-deep`, `on-moss` | `bg-moss` …       | Primary buttons, the reader's notes, links in chrome          |
| `rubric`                       | `text-rubric`     | Eyebrows, progress percentage, notes badge. Never large fills |
| `gilt`                         | `bg-gilt`         | Progress ribbon, ornament sprig. A mark, never body text      |
| `highlight`                    | `bg-highlight`    | Text selection wash                                           |
| `danger`                       | `text-danger`     | Destructive actions and errors, always with a word            |
| `rule`, `rule-strong`          | `border-rule` …   | Hairline dividers; borders that define a control              |
| `scrim`                        | `bg-scrim`        | Behind dialogs and sheets                                     |
| `cloth-*`, `cloth-lettering`   | `bg-cloth-moss` … | Covers without art, via `BookCover`                           |

`ink`, `ink-soft` and `ink-faint` pass 4.5:1 on all three paper grounds in every
theme. The design system specifies only Sepia's ground (`#e9dcc0`) and ink
(`#3a2e22`); the other Sepia tokens are derived to keep the same contrast.

The epub.js iframe cannot read CSS variables, so `src/lib/themes.ts` keeps raw
page colors for it, the browser theme color and the page color swatches.

## Type

Two families, both SIL Open Font License, self-hosted through Fontsource (Latin
subsets only, so they stay in the offline precache):

- **EB Garamond** (`font-book`), the book's voice: display, titles, the book's
  own text, and any passage quoted from it (always italic).
- **Alegreya Sans** (`font-ui`, the body default), the conversation's voice:
  Rami's replies, the reader's notes, the composer, and every interface label.

If the words are the book's, set them in Garamond; if they are ours (the
reader's or Rami's), set them in Alegreya Sans. Never set conversation in
Garamond or a quotation from the book in Alegreya Sans.

The one exception is the book's running text inside the reader, where the
reader picks the face in Settings: Literata (the default), EB Garamond (at
weight 500) or Charis SIL. `READER_FONTS` in `src/lib/themes.ts` holds each
one's files, weight and line height. Titles, headings and quoted passages
elsewhere stay in Garamond.

Pair a family with a scale step: `text-display` once per screen, `text-title`,
`text-heading`, `text-book-title`, `text-reading`, `text-passage`, `text-body`,
`text-label`, `text-control`, `text-meta`, `text-caption`. Running heads use the
`eyebrow` class (rubric small caps). Never set Garamond below 14px. Alegreya
Sans runs small, so conversation prose uses `text-body` (18px), a step above
the interface's 16px.

## Space, shape and depth

- Spacing steps of 4, 8, 12, 16, 24, 32, 48 and 64px. Phone gutter 16px, sheets
  24px, sections 48px.
- Library and settings max out at `max-w-page` (1080px); book text and replies at
  `max-w-reading` (34em).
- Radii: `rounded-sm` (3px) for the spine edge, badges and the ribbon;
  `rounded-md` (8px) for buttons, inputs and cards; `rounded-lg` (16px) for
  sheets, dialogs, the selection bar and composer; `rounded-full` for icon
  buttons only. Text buttons are never pills.
- Depth: `shadow-leaf` for a card on the page, `shadow-book` for a cover,
  `shadow-sheet` for sheets and floating bars. Most surfaces need no shadow;
  separate with `rule` first.
- Texture: `paper-grain` adds a faint fiber grain to the library, settings and
  threads pages. Never inside the reader.

## Controls

From `src/components/ui.ts`:

- `button.primary` (moss) for the one main action. Never two side by side.
- `button.secondary` (outlined) for alternatives.
- `button.quiet` (moss text) for low-stakes actions in lists and sheets.
- `button.danger` for destructive actions, with an explicit verb such as
  “Remove book”, never “OK”.
- `iconButton` for round, icon-only chrome. Always give it an `aria-label`.
- `card` for a settings group.

All controls are at least 44px tall.

## States and motion

- Focus: 2px solid `focus` with a 2px offset on every interactive element, set
  globally in `index.css`. The composer instead turns its own edge into a 2px
  `focus` border and suppresses the textarea's ring, so focus shows once.
- Hover: fills deepen (`moss` to `moss-deep`); outlines and quiet buttons gain a
  `paper-sunk` wash.
- Disabled: 45% opacity; never remove the label.
- Errors read as a sentence in `danger` that says what to do next.
- 150ms for color changes; 250 to 300ms ease-out for sheets rising and covers
  lifting (3px with a quarter-degree tilt). Under reduced motion, drop movement
  and keep fades.

## Iconography and imagery

Line icons on a 24px grid, 1.7 stroke, round caps and joins, in `currentColor`
(`src/components/Icons.tsx`). 20px in chrome, 18px in buttons, 12px in badges.
Icon-only buttons always carry a label. The one illustrative glyph is the gilt
sprig in `Ornament`. Book covers are the imagery; there are no illustrations,
mascots or stock photos.

## Layout patterns

- **Library:** header with the wordmark and a primary “Add book”; the greeting in
  `text-display`; one continue card; then “All books” over a grid of book cards
  (2 columns on phones, 3 at 640px, 4 at 1024px).
- **Reader:** the page is the book. Chrome takes the page color and hides until
  tapped. Selection raises the selection bar.
- **Thread:** a sheet on `paper-leaf` with the `Passage` at its head, notes
  below, and the composer at the foot.
- **Settings:** grouped `card` sections with an `Ornament` between groups. Never
  more than one ornament in view.
