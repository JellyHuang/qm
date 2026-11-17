# diff_xlsx: header, key and what the summary says

Unchanged defaults: the header is the first row among the first 10 non-empty rows that is mostly text (at least 60% of its span, at least two cells when any row has two) and is followed by a data row; the key is the first header column; both can be overridden per sheet.

## What the summary reports

Per sheet: `baseHeaderRow` and `headHeaderRow` (`null` only when that side has no row with content), `baseHeaderDetection` and `headHeaderDetection`:

- `rule`: a row in the window qualified.
- `fallback_first_row`: no row qualified (for example a header made of numbers), the first non-empty row was used.
- `override`: `overrides.<sheet>.headerRow`.
- `none`: the sheet has no row with content, or the sheet is not in that workbook.

When the default key is empty or duplicated, or the key column differs between the sides, the differences are `ambiguous` and the summary adds `suggestedKeyColumns`: column letters of the first single column, or else the first pair of the first six shared columns, that is non-empty and unique on both sides. Pass them back as `overrides.<sheet>.keyColumns` (letters are accepted, and a letter override compares the same column even when its header text changed).

## What caused a null header row or a removed sheet

- Rows without content before the header (formatted empty rows) used to fill the 10 row window, so a header on row 12 or later was never found. Only rows with content count now.
- Workbooks whose elements carry a namespace prefix (`<x:sheet>`, `<x:row>`) were read as having no sheets, so every sheet looked removed. Prefixes are ignored now.
- Package entries stored with backslashes (`xl\worksheets\sheet1.xml`) were not found. Backslashes are read as slashes now.
- More than ten title rows still fool the rule (the first title row is chosen); the summary shows `headerDetection: rule` with the chosen row, and `overrides.<sheet>.headerRow` fixes it.
- A renamed sheet is a removed plus an added sheet by design.

## Diagnostics without content

`createService(...).diagnoseXlsx(input)` runs the same parse and ingest as `diff_xlsx` and returns one object per workbook, sheet and side, and per compared sheet: sheet names, row and column counts, the first 15 rows as counts of non-empty, text, numeric and formula cells, the reason each candidate header row was accepted or rejected, the number of empty and duplicate keys in the default key column, the key column letters, `suggestedKeyColumns` and why a sheet is reported as added or removed. It never returns a cell value or a header text. It is not an MCP tool; the integration test file exposes it (`real-server-it.md`).
