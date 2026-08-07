"""Splitting a book into speakable segments and anchoring them in the markup.

Each sentence is wrapped in a `<span id="mg-000123">` in a *derived* copy of the
EPUB. That id is the join between the audio and the reader: the browser resolves
it to a Range and then to a CFI with `contents.cfiFromRange`, which is the same
move `src/lib/chapters.ts` already makes for table-of-contents anchors.

Anchoring on ids rather than character offsets is not an arbitrary choice. Offsets
would have to survive this tool's HTML parse and the browser's DOM agreeing on
whitespace normalisation, entity expansion and implied elements, and they do not.
An id survives reflow, font-size changes and theme switches, which is exactly the
property EPUB 3 Media Overlays relies on for the same job.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from lxml import etree

from .book import EPUB_OPS, XHTML, local_name

#: Elements that hold prose. One of these with no block-level descendant is a
#: "leaf block", the unit this walker segments.
BLOCK_TAGS = frozenset(
    {
        'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'dd', 'dt',
        'blockquote', 'div', 'td', 'th', 'figcaption', 'caption', 'pre',
        'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
        'ol', 'ul', 'dl', 'table', 'tbody', 'thead', 'tr', 'figure', 'body',
    }
)

#: Never spoken, whatever they contain.
SKIP_TAGS = frozenset({'script', 'style', 'head', 'title', 'nav', 'rt', 'rp'})

#: Visual breaks that carry no text of their own. They still have to contribute
#: whitespace: `left.<br/>Then` extracts as `left.Then`, which reads as one word
#: to the sentence splitter and comes out of the model as one word too.
BREAK_TAGS = frozenset({'br', 'hr'})

#: `epub:type` values that mark navigational furniture rather than prose.
SKIP_EPUB_TYPES = frozenset({'toc', 'landmarks', 'page-list', 'loi', 'lot', 'cover'})

#: Trailing "words" that end in a period without ending a sentence.
ABBREVIATIONS = frozenset(
    {
        'mr', 'mrs', 'ms', 'dr', 'st', 'sta', 'capt', 'capt', 'col', 'gen', 'lt',
        'sgt', 'maj', 'cmdr', 'adm', 'rev', 'hon', 'prof', 'pres', 'gov', 'sen',
        'jr', 'sr', 'esq', 'vs', 'etc', 'viz', 'inc', 'ltd', 'co', 'no', 'nos',
        'fig', 'figs', 'vol', 'vols', 'ch', 'chap', 'pp', 'ed', 'eds', 'al',
        'ibid', 'cf', 'approx', 'dept', 'univ', 'mt', 'ft', 'ave', 'blvd',
        'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
        'nov', 'dec', 'i.e', 'e.g',
    }
)

_SENTENCE_END = re.compile(r'[.!?…]+[")\]’”\']*(?=\s|$)')
_WORD_BEFORE = re.compile(r'([\w.’\']+)$', re.UNICODE)
_CLAUSE_BREAK = re.compile(r'[;:—](?=\s)')
_COMMA_BREAK = re.compile(r',(?=\s)')


@dataclass
class Segment:
    """One utterance: a span in the derived book, and the text to synthesize."""

    id: str
    text: str
    #: Archive path of the spine document it lives in.
    path: str
    #: Document order of the block that contains it, used to slice into parts.
    order: int


@dataclass
class SegmentOptions:
    max_chars: int = 320
    min_chars: int = 40
    #: Elements carrying any of these classes are skipped whole. The defaults are
    #: Project Gutenberg's boilerplate header/footer and its inline contents list,
    #: neither of which anyone wants read aloud.
    skip_classes: frozenset[str] = frozenset({'pg-boilerplate', 'toc'})
    id_prefix: str = 'mg-'


class SegmentError(RuntimeError):
    pass


def segment_document(
    tree: etree._ElementTree,
    path: str,
    start_index: int,
    options: SegmentOptions,
    fragments: set[str],
) -> tuple[list[Segment], dict[str, int]]:
    """Wraps every sentence in `tree` in a span, in place.

    Returns the segments and the document-order index of each requested anchor
    fragment, so a caller can slice the segments at chapter boundaries.

    `start_index` is the running segment counter, so ids are unique book-wide.

    The document's text is compared before and after. Restructuring markup around
    text is exactly the kind of change that goes subtly wrong on an EPUB nobody
    tested against, and silently dropping a paragraph would show up only as audio
    that skips a line, hours in.
    """
    root = tree.getroot()
    before = _normalized_text(root)

    taken_ids = {el.get('id') for el in root.iter() if isinstance(el.tag, str) and el.get('id')}
    blocks, positions = _scan(root, options, fragments)

    segments: list[Segment] = []
    counter = start_index
    for order, block in blocks:
        groups = _plan_block(block, options)
        if not groups:
            continue
        for span_id, span_text in _apply_groups(block, groups, counter, taken_ids, options):
            counter += 1
            if span_text:
                segments.append(Segment(id=span_id, text=span_text, path=path, order=order))

    after = _normalized_text(root)
    if before != after:
        raise SegmentError(
            f'{path}: rewriting changed the document text. Refusing to emit a book '
            f'whose prose no longer matches the source.'
        )
    return segments, positions


def _scan(root, options: SegmentOptions, fragments: set[str]):
    """One pass over the document: leaf blocks to speak, and where the anchors are.

    Both come out of a single `iter()` so their indices are directly comparable.
    The blocks are held by reference rather than looked up later by `id()`: lxml
    hands out throwaway proxy objects for the same underlying node, so a proxy's
    `id()` is reused as soon as it is collected and is useless as a key.
    """
    blocks: list[tuple[int, object]] = []
    positions: dict[str, int] = {}

    for index, element in enumerate(root.iter()):
        if not isinstance(element.tag, str):
            continue

        for key in ('id', 'name'):
            value = element.get(key)
            if value in fragments and value not in positions:
                positions[value] = index

        if _skipped(element, options) or _has_skipped_ancestor(element, options):
            continue
        if local_name(element) not in BLOCK_TAGS:
            continue
        children = [child for child in element if isinstance(child.tag, str)]
        if any(local_name(child) in BLOCK_TAGS for child in children):
            continue
        if ''.join(element.itertext()).strip():
            blocks.append((index, element))

    return blocks, positions


def _has_skipped_ancestor(element, options: SegmentOptions) -> bool:
    return any(_skipped(ancestor, options) for ancestor in element.iterancestors())


def _span_id(index: int, options: SegmentOptions) -> str:
    return f'{options.id_prefix}{index:06d}'


def _normalized_text(root) -> str:
    return ' '.join(''.join(root.itertext()).split())


def _skipped(element, options: SegmentOptions) -> bool:
    name = local_name(element)
    if not name or name in SKIP_TAGS:
        return True
    if element.get(f'{{{EPUB_OPS}}}type', '') in SKIP_EPUB_TYPES:
        return True
    classes = set(element.get('class', '').split())
    return bool(classes & options.skip_classes)


# --- Block rewriting -------------------------------------------------------
#
# A block is flattened into "items": literal strings (the block's own text and
# each child's tail) and whole child elements. Sentence boundaries are computed
# over the concatenation, then snapped back onto item boundaries.
#
# The snapping rule is what keeps the output well-formed: a boundary that falls
# inside a child element is pushed to that element's end. Splitting `<i>Pequod.
# She</i>` across two spans would mean re-parenting half an element, so instead
# those two sentences share one span. Slightly coarser anchoring, never broken
# markup.


def _items(block) -> list[tuple[str, str | None, object]]:
    items: list[tuple[str, str | None, object]] = []
    if block.text:
        items.append(('text', block.text, None))
    for child in block:
        if not isinstance(child.tag, str):
            continue
        items.append(('element', None, child))
        if child.tail:
            items.append(('text', child.tail, None))
    return items


def _item_text(kind: str, value: str | None, element) -> str:
    if kind == 'text':
        return value or ''
    return element_text(element)


def element_text(element) -> str:
    """Text of an element, with visual breaks rendered as whitespace.

    Used for both sentence detection and the text handed to the model, so the two
    always agree on where one utterance ends. Not used for the before/after text
    comparison, which stays on raw `itertext()` so it can catch real losses.
    """
    out: list[str] = []

    def walk(node) -> None:
        if local_name(node) in BREAK_TAGS:
            out.append(' ')
        if node.text:
            out.append(node.text)
        for child in node:
            if not isinstance(child.tag, str):
                continue
            walk(child)
            if child.tail:
                out.append(child.tail)

    walk(element)
    return ''.join(out)


def _plan_block(block, options: SegmentOptions) -> list[list[tuple[int, int, int]]]:
    """Groups a block's items into spans, one per sentence.

    Each group is a list of `(item_index, start, end)` slices; for element items
    `start`/`end` are ignored and the whole element is taken.
    """
    items = _items(block)
    if not items:
        return []

    spans_of_item: list[tuple[int, int]] = []
    offset = 0
    for kind, value, element in items:
        length = len(_item_text(kind, value, element))
        spans_of_item.append((offset, offset + length))
        offset += length
    total = offset
    if not total:
        return []

    text = ''.join(_item_text(kind, value, element) for kind, value, element in items)
    cuts = _sentence_cuts(text, options)

    # Snap each cut onto a position we can actually split at.
    snapped: list[int] = []
    for cut in cuts:
        index = _item_at(spans_of_item, cut)
        kind = items[index][0]
        if kind == 'element':
            cut = spans_of_item[index][1]
        if 0 < cut < total and (not snapped or cut > snapped[-1]):
            snapped.append(cut)

    boundaries = [0, *snapped, total]
    groups: list[list[tuple[int, int, int]]] = []
    for start, end in zip(boundaries, boundaries[1:]):
        group = _slice_items(items, spans_of_item, start, end)
        if group:
            groups.append(group)

    return _merge_empty(groups, items) if groups else []


def _item_at(spans: list[tuple[int, int]], offset: int) -> int:
    for index, (start, end) in enumerate(spans):
        if start <= offset < end:
            return index
    return len(spans) - 1


def _slice_items(
    items, spans: list[tuple[int, int]], start: int, end: int
) -> list[tuple[int, int, int]]:
    group: list[tuple[int, int, int]] = []
    for index, (item_start, item_end) in enumerate(spans):
        kind = items[index][0]
        if kind == 'element':
            # Zero-length elements (`<br/>`) sit exactly on a boundary; assign
            # them to the group that starts there so they are never dropped.
            if item_start == item_end:
                if start <= item_start < end or (end == item_start and item_end == end):
                    group.append((index, 0, 0))
            elif item_start >= start and item_end <= end:
                group.append((index, 0, 0))
            continue
        lo, hi = max(start, item_start), min(end, item_end)
        if lo < hi:
            group.append((index, lo - item_start, hi - item_start))
    return group


def _merge_empty(groups, items) -> list[list[tuple[int, int, int]]]:
    """Folds groups with no speakable text into a neighbour.

    A group holding only `<br/>` and whitespace would otherwise become a span
    with an id, no audio, and a gap in the sync map.
    """

    def group_text(group) -> str:
        parts = []
        for index, start, end in group:
            kind, value, element = items[index]
            parts.append(_item_text(kind, value, element)[start:end] if kind == 'text' else '')
        return ''.join(parts).strip()

    merged: list[list[tuple[int, int, int]]] = []
    for group in groups:
        if not group_text(group) and merged:
            merged[-1].extend(group)
        else:
            merged.append(group)

    # A leading empty group has no previous neighbour; fold it forward instead.
    if len(merged) > 1 and not group_text(merged[0]):
        merged[1][:0] = merged[0]
        merged.pop(0)
    return merged


def _apply_groups(
    block, groups, counter: int, taken_ids: set[str], options
) -> list[tuple[str, str]]:
    """Replaces a block's children with one span per group.

    Returns `(span id, speakable text)` for each group, in document order.
    """
    # Rebuilt rather than passed in, so it must be identical to the list
    # `_plan_block` indexed against: both read the block before any mutation.
    items = _items(block)

    # Tails travel with an element when lxml reparents it, and every tail is
    # already a separate text item, so clear them before moving anything.
    for child in block:
        child.tail = None
    block.text = None
    for child in list(block):
        block.remove(child)

    spans: list[tuple[str, str]] = []
    for offset, group in enumerate(groups):
        span = etree.Element(f'{{{XHTML}}}span')
        span_id = _unique_id(counter + offset, taken_ids, options)
        span.set('id', span_id)
        for index, start, end in group:
            kind, value, element = items[index]
            if kind == 'element':
                span.append(element)
            else:
                _append_text(span, (value or '')[start:end])
        block.append(span)
        spans.append((span_id, ' '.join(element_text(span).split())))
    return spans


def _unique_id(index: int, taken_ids: set[str], options: SegmentOptions) -> str:
    span_id = _span_id(index, options)
    while span_id in taken_ids:
        span_id += 'x'
    taken_ids.add(span_id)
    return span_id


def _append_text(span, text: str) -> None:
    if not text:
        return
    if len(span):
        last = span[-1]
        last.tail = (last.tail or '') + text
    else:
        span.text = (span.text or '') + text


# --- Sentence boundaries ---------------------------------------------------


def _sentence_cuts(text: str, options: SegmentOptions) -> list[int]:
    """Offsets in `text` where one utterance ends and the next begins."""
    cuts: list[int] = []
    for match in _SENTENCE_END.finditer(text):
        if _is_abbreviation(text, match.start()):
            continue
        cuts.append(match.end())

    cuts = _merge_short(cuts, options.min_chars)
    return _split_long(text, cuts, options.max_chars)


def _is_abbreviation(text: str, dot: int) -> bool:
    if text[dot] != '.':
        return False
    word = _WORD_BEFORE.search(text[:dot])
    if not word:
        return False
    token = word.group(1).rstrip('.').lower()
    # Single letters are initials ("R. W. Emerson"), and a known abbreviation
    # ends a word, not a sentence. Both are common enough in a 19th century
    # novel that ignoring them chops utterances mid-name.
    return len(token) == 1 or token in ABBREVIATIONS


def _merge_short(cuts: list[int], min_chars: int) -> list[int]:
    kept: list[int] = []
    previous = 0
    for cut in cuts:
        if cut - previous < min_chars:
            continue
        kept.append(cut)
        previous = cut
    return kept


def _split_long(text: str, cuts: list[int], max_chars: int) -> list[int]:
    """Breaks over-long stretches at clause boundaries.

    Melville writes sentences that run past 1,000 characters. Left whole they
    make a single audio segment several minutes long, which is too coarse to
    highlight or to resume from, and long enough to destabilise generation on
    autoregressive models.
    """
    result: list[int] = []
    previous = 0
    for cut in [*cuts, len(text)]:
        start = previous
        while cut - start > max_chars:
            split = _best_break(text, start, min(start + max_chars, cut))
            if split is None or split <= start:
                break
            result.append(split)
            start = split
        if cut < len(text):
            result.append(cut)
        previous = cut
    return result


def _best_break(text: str, start: int, limit: int) -> int | None:
    window = text[start:limit]
    for pattern in (_CLAUSE_BREAK, _COMMA_BREAK):
        matches = list(pattern.finditer(window))
        if matches:
            return start + matches[-1].end()
    space = window.rfind(' ')
    return start + space + 1 if space > 0 else None
