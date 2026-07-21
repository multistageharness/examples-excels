#!/usr/bin/env python3
"""Read and rewrite the Power Query M code embedded in an .xlsx workbook.

    python3 inject_m.py TEMPLATE --print-m                 # dump the M code that is in there
    python3 inject_m.py TEMPLATE --m-code q.m -o OUT.xlsx  # replace it and write a new workbook
    python3 inject_m.py TEMPLATE --m-code - -o OUT.xlsx    # ...reading the M from stdin

The workbook is a ZIP. Every part is copied to the output byte-for-byte except the one that
carries the query, so nothing else in the file can be disturbed.

THE ACTUAL ON-DISK FORMAT (verified against a real Excel-authored workbook)
--------------------------------------------------------------------------
The M code is nested four layers deep, and only the outermost layer is what you would guess:

    workbook.xlsx                     a ZIP
      customXml/item1.xml             UTF-16-encoded XML  <- not UTF-8
        <DataMashup>...</DataMashup>  base64
          uint32 version              little-endian
          uint32 package_length       little-endian
          package                     ANOTHER ZIP, `package_length` bytes
            Formulas/Section1.m       the M code, as plain UTF-8 text
          ...permissions, metadata, and bindings follow the package

So the M code is NOT a base64'd UTF-16LE string sitting in the XML -- it is a UTF-8 file inside
a ZIP inside a length-prefixed binary blob inside base64 inside UTF-16 XML. A heuristic that
base64-decodes the node and looks for "let" in a UTF-16LE decoding will not find it.

DO NOT ROUND-TRIP THE TEMPLATE THROUGH openpyxl
-----------------------------------------------
openpyxl does not preserve parts it does not model. A bare `load_workbook(f); wb.save(f)` on a
query-bearing workbook silently drops:

    customXml/item1.xml, customXml/itemProps1.xml, customXml/_rels/item1.xml.rels,
    xl/connections.xml, xl/queryTables/queryTable1.xml

...which is the entire Power Query. Edit the data in the template's own tables and inject into
the template directly; never save the template with openpyxl and then try to inject into the
result -- the customXml directory will not be there any more.
"""

from __future__ import annotations

import argparse
import base64
import io
import re
import sys
import zipfile
from pathlib import Path
from typing import Optional, Tuple

SECTION = "Formulas/Section1.m"
DATAMASHUP_RE = re.compile(r"(<DataMashup[^>]*>)(.*?)(</DataMashup>)", re.S)

EXIT_OK = 0
EXIT_ERROR = 1


class MashupError(Exception):
    """The workbook does not carry a Power Query payload we can rewrite."""


def _decode_xml(raw: bytes) -> Tuple[str, str]:
    """customXml parts are UTF-16 in practice; fall back to UTF-8. Returns (text, encoding)."""
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16"), "utf-16"
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return raw.decode("utf-16"), "utf-16"


def find_mashup_part(archive: zipfile.ZipFile) -> str:
    """Locate the customXml part holding the <DataMashup> node. It is not always item1.xml."""
    for name in archive.namelist():
        if not name.startswith("customXml/") or not name.endswith(".xml"):
            continue
        text, _ = _decode_xml(archive.read(name))
        if DATAMASHUP_RE.search(text):
            return name
    raise MashupError(
        "No <DataMashup> part found. You must start from a template workbook that already "
        "has a Power Query in it -- Excel rejects a customXml tree built from scratch."
    )


def _split_payload(payload: bytes) -> Tuple[bytes, bytes, bytes]:
    """Split the mashup blob into (header, package_zip, trailer).

    header  = uint32 version + uint32 package_length
    trailer = permissions / metadata / bindings, preserved verbatim.
    """
    if len(payload) < 8:
        raise MashupError("DataMashup payload is too short to be a mashup package.")

    package_length = int.from_bytes(payload[4:8], "little")
    start, end = 8, 8 + package_length

    if payload[start:start + 2] != b"PK" or end > len(payload):
        raise MashupError(
            "DataMashup payload does not contain a ZIP package where the length prefix says "
            "it should. This workbook's mashup format is not the one this script handles."
        )

    return payload[:8], payload[start:end], payload[end:]


def read_m(path: Path) -> str:
    """Return the M code (Formulas/Section1.m) currently embedded in the workbook."""
    with zipfile.ZipFile(path) as archive:
        text, _ = _decode_xml(archive.read(find_mashup_part(archive)))

    payload = base64.b64decode(DATAMASHUP_RE.search(text).group(2))
    _, package, _ = _split_payload(payload)

    with zipfile.ZipFile(io.BytesIO(package)) as inner:
        if SECTION not in inner.namelist():
            raise MashupError(f"The mashup package has no {SECTION}.")
        return inner.read(SECTION).decode("utf-8")


def _rebuild_package(package: bytes, m_code: str) -> bytes:
    """Rewrite Formulas/Section1.m inside the mashup package, keeping every other entry."""
    with zipfile.ZipFile(io.BytesIO(package)) as inner:
        entries = [(info, inner.read(info.filename)) for info in inner.infolist()]

    if not any(info.filename == SECTION for info, _ in entries):
        raise MashupError(f"The mashup package has no {SECTION} to replace.")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as out:
        for info, data in entries:
            payload = m_code.encode("utf-8") if info.filename == SECTION else data
            # Reuse the original ZipInfo so timestamps/attrs stay stable across a rewrite.
            out.writestr(info, payload)

    return buffer.getvalue()


def inject_m(template: Path, output: Path, m_code: str) -> None:
    """Write `output`: `template` with its M code replaced, every other part untouched."""
    with zipfile.ZipFile(template) as archive:
        part = find_mashup_part(archive)
        text, encoding = _decode_xml(archive.read(part))
        entries = [(info, archive.read(info.filename)) for info in archive.infolist()]

    match = DATAMASHUP_RE.search(text)
    header, package, trailer = _split_payload(base64.b64decode(match.group(2)))

    package = _rebuild_package(package, m_code)

    # The length prefix describes the package, so it has to be recomputed, not copied.
    rebuilt = header[:4] + len(package).to_bytes(4, "little") + package + trailer
    encoded = base64.b64encode(rebuilt).decode("ascii")

    patched = text[: match.start()] + match.group(1) + encoded + match.group(3) + text[match.end():]
    part_bytes = patched.encode(encoding)

    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as out:
        for info, data in entries:
            out.writestr(info, part_bytes if info.filename == part else data)


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="inject_m",
        description="Read or replace the Power Query M code embedded in an .xlsx workbook.",
    )
    parser.add_argument("template", type=Path, help="an .xlsx that already contains a query")
    parser.add_argument("--print-m", action="store_true", help="print the embedded M and exit")
    parser.add_argument("--m-code", metavar="FILE", help="file with the new M code ('-' for stdin)")
    parser.add_argument("-o", "--output", type=Path, help="where to write the new workbook")
    args = parser.parse_args(argv)

    try:
        if args.print_m:
            print(read_m(args.template))
            return EXIT_OK

        if not args.m_code or not args.output:
            parser.error("--m-code and --output are both required (or pass --print-m)")

        m_code = sys.stdin.read() if args.m_code == "-" else Path(args.m_code).read_text("utf-8")

        if args.output.resolve() == args.template.resolve():
            parser.error("--output must differ from the template; refusing to overwrite it")

        inject_m(args.template, args.output, m_code)
    except MashupError as exc:
        print(f"inject_m: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except OSError as exc:
        print(f"inject_m: {exc}", file=sys.stderr)
        return EXIT_ERROR

    # Read the M straight back out of the file we just wrote: an injection that did not survive
    # the round-trip is a corrupt workbook, and it is better to hear that now than from Excel.
    if read_m(args.output).strip() != m_code.strip():
        print("inject_m: the injected M did not read back identically -- output is suspect.",
              file=sys.stderr)
        return EXIT_ERROR

    print(f"inject_m: wrote {args.output} ({args.output.stat().st_size} bytes), M verified.",
          file=sys.stderr)
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
