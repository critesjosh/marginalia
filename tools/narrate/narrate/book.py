"""Reading and rewriting an EPUB container.

Deliberately minimal: enough of the OPF and the navigation document to walk the
spine in reading order and resolve table-of-contents anchors, and nothing else.
The whole archive is held in memory as `name -> bytes` so the derived book can
be written back with every asset it started with, including the ones this tool
never looks at.
"""

from __future__ import annotations

import posixpath
import zipfile
from dataclasses import dataclass, field
from urllib.parse import unquote

from lxml import etree

XHTML = 'http://www.w3.org/1999/xhtml'
OPF = 'http://www.idpf.org/2007/opf'
DC = 'http://purl.org/dc/elements/1.1/'
NCX = 'http://www.daisy.org/z3986/2005/ncx/'
CONTAINER = 'urn:oasis:names:tc:opendocument:xmlns:container'
EPUB_OPS = 'http://www.idpf.org/2007/ops'

# `recover` matters more than it looks: EPUBs are nominally well-formed XML, but
# plenty of real ones are not, and refusing to narrate a book over a stray tag
# helps nobody.
_PARSER = etree.XMLParser(resolve_entities=False, recover=True, huge_tree=True)


def parse_xml(data: bytes) -> etree._ElementTree:
    return etree.ElementTree(etree.fromstring(data, _PARSER))


def local_name(element) -> str:
    """Tag name without its namespace, or '' for comments and processing instructions."""
    tag = element.tag
    if not isinstance(tag, str):
        return ''
    return tag.rpartition('}')[2]


@dataclass
class SpineDoc:
    """One XHTML document in reading order."""

    idref: str
    #: Archive path, e.g. `OEBPS/chapter-1.xhtml`.
    path: str
    #: Path relative to the OPF, which is how the navigation document links to it.
    href: str


@dataclass
class TocEntry:
    label: str
    #: Spine document this entry points into.
    path: str
    #: Fragment id within that document, if the entry has one.
    fragment: str | None


@dataclass
class Epub:
    path: str
    files: dict[str, bytes]
    opf_path: str
    title: str = ''
    author: str = ''
    language: str = ''
    spine: list[SpineDoc] = field(default_factory=list)
    toc: list[TocEntry] = field(default_factory=list)

    @property
    def opf_dir(self) -> str:
        return posixpath.dirname(self.opf_path)

    def resolve(self, href: str, base_dir: str) -> str:
        """Turns a document-relative href into an archive path."""
        href = unquote(href.split('#')[0])
        return posixpath.normpath(posixpath.join(base_dir, href)).lstrip('/')

    def save(self, out_path: str) -> None:
        with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            # The mimetype entry must come first and be stored uncompressed, or
            # strict readers reject the container outright.
            if 'mimetype' in self.files:
                zf.writestr(
                    zipfile.ZipInfo('mimetype'),
                    self.files['mimetype'],
                    zipfile.ZIP_STORED,
                )
            for name, data in self.files.items():
                if name == 'mimetype':
                    continue
                zf.writestr(name, data)


def load(path: str) -> Epub:
    with zipfile.ZipFile(path) as zf:
        files = {name: zf.read(name) for name in zf.namelist() if not name.endswith('/')}

    opf_path = _find_opf(files)
    book = Epub(path=path, files=files, opf_path=opf_path)

    opf = parse_xml(files[opf_path]).getroot()
    _read_metadata(book, opf)
    manifest = _read_manifest(opf)
    _read_spine(book, opf, manifest)
    book.toc = _read_toc(book, opf, manifest)
    return book


def _find_opf(files: dict[str, bytes]) -> str:
    container = files.get('META-INF/container.xml')
    if container:
        root = parse_xml(container).getroot()
        for rootfile in root.iter(f'{{{CONTAINER}}}rootfile'):
            full_path = rootfile.get('full-path')
            if full_path and full_path in files:
                return full_path

    # Some hand-built archives have no container.xml; a single .opf is unambiguous.
    candidates = [name for name in files if name.lower().endswith('.opf')]
    if len(candidates) == 1:
        return candidates[0]
    raise ValueError('Could not locate the OPF package document in this EPUB.')


def _read_metadata(book: Epub, opf) -> None:
    def first(tag: str) -> str:
        for element in opf.iter(f'{{{DC}}}{tag}'):
            if element.text:
                return element.text.strip()
        return ''

    book.title = first('title')
    book.author = first('creator')
    book.language = first('language') or 'en'


def _read_manifest(opf) -> dict[str, dict[str, str]]:
    manifest: dict[str, dict[str, str]] = {}
    for item in opf.iter(f'{{{OPF}}}item'):
        item_id = item.get('id')
        href = item.get('href')
        if not item_id or not href:
            continue
        manifest[item_id] = {
            'href': href,
            'media_type': item.get('media-type', ''),
            'properties': item.get('properties', ''),
        }
    return manifest


def _read_spine(book: Epub, opf, manifest: dict[str, dict[str, str]]) -> None:
    for itemref in opf.iter(f'{{{OPF}}}itemref'):
        idref = itemref.get('idref')
        item = manifest.get(idref or '')
        if not item or 'xhtml' not in item['media_type']:
            continue
        path = book.resolve(item['href'], book.opf_dir)
        if path in book.files:
            book.spine.append(SpineDoc(idref=idref or '', path=path, href=item['href']))


def _read_toc(book: Epub, opf, manifest: dict[str, dict[str, str]]) -> list[TocEntry]:
    """Prefers the EPUB 3 navigation document, falling back to the EPUB 2 NCX."""
    for item in manifest.values():
        if 'nav' in item['properties'].split():
            path = book.resolve(item['href'], book.opf_dir)
            if path in book.files:
                entries = _read_nav(book, path)
                if entries:
                    return entries

    spine = opf.find(f'{{{OPF}}}spine')
    ncx_id = spine.get('toc') if spine is not None else None
    item = manifest.get(ncx_id or '')
    if item:
        path = book.resolve(item['href'], book.opf_dir)
        if path in book.files:
            return _read_ncx(book, path)
    return []


def _read_nav(book: Epub, nav_path: str) -> list[TocEntry]:
    root = parse_xml(book.files[nav_path]).getroot()
    base = posixpath.dirname(nav_path)

    for nav in root.iter(f'{{{XHTML}}}nav'):
        if nav.get(f'{{{EPUB_OPS}}}type') != 'toc':
            continue
        return [
            entry
            for anchor in nav.iter(f'{{{XHTML}}}a')
            if (entry := _entry_from_anchor(book, anchor, base))
        ]
    return []


def _entry_from_anchor(book: Epub, anchor, base: str) -> TocEntry | None:
    href = anchor.get('href')
    if not href or href.startswith(('http://', 'https://')):
        return None
    path = book.resolve(href, base)
    if path not in book.files:
        return None
    _, _, fragment = href.partition('#')
    label = ' '.join(''.join(anchor.itertext()).split())
    return TocEntry(label=label or 'Untitled', path=path, fragment=unquote(fragment) or None)


def _read_ncx(book: Epub, ncx_path: str) -> list[TocEntry]:
    root = parse_xml(book.files[ncx_path]).getroot()
    base = posixpath.dirname(ncx_path)

    entries: list[TocEntry] = []
    # navPoints nest, and `iter` yields them in document order, which for a well
    # formed NCX is also reading order.
    for point in root.iter(f'{{{NCX}}}navPoint'):
        content = point.find(f'{{{NCX}}}content')
        label_el = point.find(f'{{{NCX}}}navLabel/{{{NCX}}}text')
        src = content.get('src') if content is not None else None
        if not src:
            continue
        path = book.resolve(src, base)
        if path not in book.files:
            continue
        _, _, fragment = src.partition('#')
        label = ' '.join((label_el.text or '').split()) if label_el is not None else ''
        entries.append(
            TocEntry(label=label or 'Untitled', path=path, fragment=unquote(fragment) or None)
        )
    return entries
