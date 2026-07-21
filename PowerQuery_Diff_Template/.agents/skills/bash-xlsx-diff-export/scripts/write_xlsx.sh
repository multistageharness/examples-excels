#!/usr/bin/env bash
# write_xlsx.sh -- build a styled .xlsx from TSV on stdin, using only zip + heredocs.
#
#   xldiff.sh book.xlsx -f tsv | write_xlsx.sh changes.xlsx
#
# An .xlsx is just a ZIP of XML parts. There is no binary format to marshal -- so a shell
# script can emit one, provided it writes every part the spec requires and gets the
# relationships between them right.
#
# The output matches the Python writer-s contract: one sheet named "Changes", a bold-white-on
# -orange header, rows fill-coded by Change_Status (Added green / Removed red / Modified
# amber), a frozen header row, and the range registered as an Excel Table named tbl_Changes
# so the output can be fed back in as input.

set -euo pipefail

OUT="${1:?usage: write_xlsx.sh OUTPUT.xlsx  (TSV on stdin)}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
mkdir -p "$(dirname "$OUT")"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/in.tsv"
[ -s "$TMP/in.tsv" ] || { echo "write_xlsx: no input on stdin" >&2; exit 1; }

D="$TMP/x"
mkdir -p "$D/_rels" "$D/xl/_rels" "$D/xl/worksheets/_rels" "$D/xl/tables"

# Style indexes referenced by the sheet below (s="N" on each cell). They are positions in
# cellXfs, so the order here is load-bearing: 0 default, 1 header, 2 Added, 3 Removed,
# 4 Modified, 5 unfilled-but-bordered (any other status).
cat > "$D/xl/styles.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="6">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFED7D31"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFCE4E4"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>
XML

# The sheet. Values go in as inline strings (t="inlineStr") except pure numbers, which go in
# as numbers -- that avoids a sharedStrings.xml part entirely and keeps the types honest.
awk -F'\t' '
  function esc(s) { gsub(/&/, "\\&amp;", s); gsub(/</, "\\&lt;", s); gsub(/>/, "\\&gt;", s); gsub(/"/, "\\&quot;", s); return s }
  function colref(n,   s, r) { s = ""; while (n > 0) { r = (n - 1) % 26; s = substr("ABCDEFGHIJKLMNOPQRSTUVWXYZ", r + 1, 1) s; n = int((n - 1) / 26) } return s }
  NR == 1 {
    for (i = 1; i <= NF; i++) { hdr[i] = $i; if (i == 1) nf = 0; nf = NF; if ($i == "Change_Status") sc = i }
    printf "<row r=\"1\" spans=\"1:%d\">", nf
    for (i = 1; i <= nf; i++) printf "<c r=\"%s1\" s=\"1\" t=\"inlineStr\"><is><t>%s</t></is></c>", colref(i), esc($i)
    printf "</row>"
    next
  }
  {
    st = (sc ? $sc : "")
    s = 0
    if (st == "Added") s = 2; else if (st == "Removed") s = 3; else if (st == "Modified") s = 4
    printf "<row r=\"%d\" spans=\"1:%d\">", NR, nf
    for (i = 1; i <= nf; i++) {
      v = $i
      ref = colref(i) NR
      if (v == "") { printf "<c r=\"%s\" s=\"%d\"/>", ref, s }
      else if (v ~ /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/) { printf "<c r=\"%s\" s=\"%d\"><v>%s</v></c>", ref, s, v }
      else { printf "<c r=\"%s\" s=\"%d\" t=\"inlineStr\"><is><t>%s</t></is></c>", ref, s, esc(v) }
    }
    printf "</row>"
    if (NR > mx) mx = NR
  }
  END { print "" > "/dev/null" }
' "$TMP/in.tsv" > "$TMP/rows.xml"

NF_COUNT=$(head -1 "$TMP/in.tsv" | awk -F'\t' '{print NF}')
NROWS=$(wc -l < "$TMP/in.tsv" | tr -d ' ')
LASTCOL=$(awk -v n="$NF_COUNT" 'BEGIN{ s=""; while (n>0) { r=(n-1)%26; s=substr("ABCDEFGHIJKLMNOPQRSTUVWXYZ",r+1,1) s; n=int((n-1)/26) } print s }')
DIM="A1:${LASTCOL}${NROWS}"

# An Excel Table needs at least one DATA row. With a header only, fall back to an autoFilter
# -- otherwise Excel calls the file corrupt. (A zero-change run is legitimate: see the gap rule.)
if [ "$NROWS" -gt 1 ]; then
  TABLEPART='<tableParts count="1"><tablePart r:id="rId1"/></tableParts>'
  SHEETREL='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>
</Relationships>'
  AUTOFILTER=""
  printf '%s\n' "$SHEETREL" > "$D/xl/worksheets/_rels/sheet1.xml.rels"
  cat > "$D/xl/tables/table1.xml" <<XML
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="tbl_Changes" displayName="tbl_Changes" ref="$DIM" totalsRowShown="0">
  <autoFilter ref="$DIM"/>
  <tableColumns count="$NF_COUNT">
$(head -1 "$TMP/in.tsv" | awk -F'\t' '{ for (i=1;i<=NF;i++) { v=$i; gsub(/&/,"\\&amp;",v); gsub(/</,"\\&lt;",v); gsub(/>/,"\\&gt;",v); gsub(/"/,"\\&quot;",v); printf "    <tableColumn id=\"%d\" name=\"%s\"/>\n", i, v } }')
  </tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>
XML
else
  TABLEPART=""
  AUTOFILTER="<autoFilter ref=\"$DIM\"/>"
  rmdir "$D/xl/worksheets/_rels" 2>/dev/null || true
fi

# Column widths: longest value in the column + padding, capped at 40.
COLS=$(awk -F'\t' '
  { for (i = 1; i <= NF; i++) if (length($i) > w[i]) w[i] = length($i); if (NF > nf) nf = NF }
  END {
    printf "<cols>"
    for (i = 1; i <= nf; i++) { x = w[i] + 4; if (x > 40) x = 40; printf "<col min=\"%d\" max=\"%d\" width=\"%d\" customWidth=\"1\"/>", i, i, x }
    printf "</cols>"
  }' "$TMP/in.tsv")

{
  printf '%s' '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  printf '%s' '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  printf '<dimension ref="%s"/>' "$DIM"
  printf '%s' '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
  printf '%s' '<sheetFormatPr defaultRowHeight="15"/>'
  printf '%s' "$COLS"
  printf '<sheetData>%s</sheetData>' "$(cat "$TMP/rows.xml")"
  printf '%s' "$AUTOFILTER"
  printf '%s' "$TABLEPART"
  printf '%s' '</worksheet>'
} > "$D/xl/worksheets/sheet1.xml"

cat > "$D/xl/workbook.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Changes" sheetId="1" r:id="rId1"/></sheets>
</workbook>
XML

cat > "$D/xl/_rels/workbook.xml.rels" <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
XML

cat > "$D/_rels/.rels" <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
XML

# Every part must be declared here or Excel rejects the file.
{
  printf '%s' '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  printf '%s' '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  printf '%s' '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  printf '%s' '<Default Extension="xml" ContentType="application/xml"/>'
  printf '%s' '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  printf '%s' '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  printf '%s' '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  [ "$NROWS" -gt 1 ] && printf '%s' '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>'
  printf '%s' '</Types>'
} > "$D/[Content_Types].xml"

[ "$NROWS" -gt 1 ] || rm -rf "$D/xl/tables"

rm -f "$OUT"
( cd "$D" && zip -q -r -X "$OUT" '[Content_Types].xml' _rels xl )

echo "write_xlsx: wrote $OUT ($((NROWS - 1)) data row(s))" >&2
