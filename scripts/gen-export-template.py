#!/usr/bin/env python3
"""(X)RUNWAY - generate public/export-template.xlsx (the charted walks sheet).

The founder call (2026-07-08 A3 + queue #3): the walks export should carry
NATIVE Excel charts so the data is easy to read + defend. No JS library
renders native charts, so the chart lives in this COMMITTED template and the
in-browser export (src/export-xlsx.ts) only writes the data rows into it and
re-fits the chart ranges - openpyxl (3.1.5, /usr/bin/python3) builds it here.

Contract with src/export-xlsx.ts + test/export-xlsx.test.ts (drift-pinned):
- ONE worksheet named WALKS; row 1 = the founder-locked eleven headers, exactly
  as historyToCsv writes them (HISTORY_EXPORT_HEADERS in session-recorder.ts).
- One native line chart anchored at L2: series overall/pace/carriage/line
  (columns H..K, series names from the header row; duration_s at G is data,
  never a series - the Y axis is the score scale) over the date column (A),
  every range ending at row LAST_ROW = 201 (HISTORY_CAP 200 + the header) -
  the browser patcher rewrites the literal "$201" to the actual last row.
- Y axis fixed 0..100 (the score scale); blanks render as gaps.

Regenerate + re-commit after any change:
  python3 scripts/gen-export-template.py
"""

from openpyxl import Workbook
from openpyxl.chart import LineChart, Reference
from openpyxl.chart.marker import Marker
from openpyxl.styles import Font

# The founder-locked eleven columns (2026-07-08 "ultra-simplify" call;
# duration_s ruled back IN at the original A3 slot with the user-set walk
# duration, 2026-07-09) - MUST equal HISTORY_EXPORT_HEADERS in
# src/session-recorder.ts (pinned by test).
HEADERS = [
    "date",
    "time",
    "lesson",
    "runway_length_m",
    "runway_width_m",
    "runway_shape",
    "duration_s",
    "overall",
    "pace",
    "carriage",
    "line",
]

HISTORY_CAP = 200  # session-recorder.ts HISTORY_CAP - the row ceiling
LAST_ROW = HISTORY_CAP + 1  # 201: the literal the browser patcher rewrites

wb = Workbook()
ws = wb.active
ws.title = "WALKS"
ws.append(HEADERS)
for cell in ws[1]:
    cell.font = Font(bold=True)
ws.freeze_panes = "A2"

# Readable column widths (date/time/lesson wider; scores narrow).
for col, width in zip("ABCDEFGHIJK", (12, 8, 18, 16, 15, 14, 11, 9, 9, 10, 9)):
    ws.column_dimensions[col].width = width

chart = LineChart()
chart.height = 11  # cm - roughly 22 rows tall, beside the data
chart.width = 24
chart.y_axis.scaling.min = 0
chart.y_axis.scaling.max = 100
chart.y_axis.delete = False
chart.x_axis.delete = False
# Blank cells (rows past the trainee's walk count never exist after the
# browser re-fits the ranges; empty metric cells on legacy rows do) read as
# gaps, never as zero scores.
chart.displayBlanksAs = "gap"

# duration_s (G) is data, NOT a series - the Y axis is the 0-100 score scale.
for col in range(8, 12):  # H..K: overall, pace, carriage, line
    series_ref = Reference(ws, min_col=col, min_row=1, max_row=LAST_ROW)
    chart.add_data(series_ref, titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=LAST_ROW))
for series in chart.series:
    series.marker = Marker(symbol="circle", size=5)
    series.smooth = False

ws.add_chart(chart, "L2")

OUT = "public/export-template.xlsx"
wb.save(OUT)
print(f"[export-template] wrote {OUT} (headers={len(HEADERS)}, ranges to row {LAST_ROW})")
