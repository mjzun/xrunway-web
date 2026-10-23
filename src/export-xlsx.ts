/**
 * (X)RUNWAY — the charted walks Excel export (founder call 2026-07-08 A3 +
 * queue #3: "use Excel charts in the sheet to make the data easier to read
 * and defend").
 *
 * No JS library renders NATIVE Excel charts, so the chart lives in a
 * COMMITTED template (public/export-template.xlsx, built by
 * scripts/gen-export-template.py with openpyxl): one WALKS sheet whose row 1
 * is the founder-locked eleven headers, plus a native line chart of
 * overall/pace/carriage/line (H..K — duration_s at G is data, NOT a series:
 * the Y axis is the 0-100 score scale) over the date column with every range
 * ending at the literal row 201 (HISTORY_CAP + the header). This module only:
 *
 *   1. writes the data rows into the sheet XML (inline strings — text cells
 *      can never execute as formulas, so the CSV's injection prefix is
 *      deliberately NOT applied here), and
 *   2. re-fits the template's fixed "$201" chart ranges + the sheet
 *      dimension to the actual last row, so the chart plots exactly the
 *      trainee's walks with no empty tail.
 *
 * The CELL VALUES come from the caller (session-recorder's historyRowCells —
 * the same extraction the CSV uses, so the two sheets can never drift).
 * Zip plumbing is fflate (a direct dependency; ~8 KB — chosen over the
 * planned JSZip for size, same job). Pure byte-in/byte-out
 * ({@link fillWalksTemplate}) so the node test suite runs the REAL fill
 * against the REAL committed template.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/** One exported cell: a string, a number, or empty ("" renders no cell). */
export type XlsxCell = string | number;

const SHEET_PATH = "xl/worksheets/sheet1.xml";
const CHART_PATH = "xl/charts/chart1.xml";
/** The template's fixed range end: HISTORY_CAP (200 rows) + the header. */
const TEMPLATE_LAST_ROW = 201;

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Escape a cell string for XML text content. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Column letters for the eleven-column sheet (A..K). */
const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];

/**
 * The `<row>` XML for data rows 2..N+1. Numbers become numeric cells (they
 * chart); strings become inline-string cells; empty strings render no cell
 * (a blank — the chart's dispBlanksAs="gap" law).
 */
export function walksRowsXml(rows: ReadonlyArray<ReadonlyArray<XlsxCell>>): string {
  let xml = "";
  rows.forEach((cells, i) => {
    const r = i + 2; // row 1 is the header
    let row = "";
    cells.forEach((v, c) => {
      if (v === "") return; // blank cell — omitted entirely
      const ref = `${COLS[c]}${r}`;
      row +=
        typeof v === "number"
          ? `<c r="${ref}"><v>${v}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(v)}</t></is></c>`;
    });
    xml += `<row r="${r}">${row}</row>`;
  });
  return xml;
}

/** Insert the data rows before `</sheetData>` + re-fit the dimension ref. */
export function patchSheetXml(sheetXml: string, rowsXml: string, lastRow: number): string {
  if (!sheetXml.includes("</sheetData>")) {
    throw new Error("export-template sheet XML has no sheetData");
  }
  return sheetXml
    .replace('<dimension ref="A1:K1" />', `<dimension ref="A1:K${lastRow}" />`)
    .replace("</sheetData>", `${rowsXml}</sheetData>`);
}

/** Re-fit every fixed `$201` chart range to the actual last data row, so the
 * chart plots exactly the exported walks (no 200-slot empty tail). */
export function patchChartXml(chartXml: string, lastRow: number): string {
  if (!chartXml.includes(`$${TEMPLATE_LAST_ROW}`)) {
    throw new Error("export-template chart XML has no $201 ranges to re-fit");
  }
  // split/join = replaceAll (the project lib target predates es2021).
  return chartXml.split(`$${TEMPLATE_LAST_ROW}`).join(`$${lastRow}`);
}

/**
 * Fill the committed template with the walk rows — pure bytes in/out (the
 * node test path). Throws on a template whose internals moved (the drift
 * pins in test/export-xlsx.test.ts catch that before any user does).
 */
export function fillWalksTemplate(
  templateBytes: Uint8Array,
  rows: ReadonlyArray<ReadonlyArray<XlsxCell>>,
): Uint8Array {
  const entries = unzipSync(templateBytes);
  const sheet = entries[SHEET_PATH];
  const chart = entries[CHART_PATH];
  if (!sheet || !chart) {
    throw new Error("export-template is missing the WALKS sheet or the chart");
  }
  const lastRow = rows.length + 1;
  entries[SHEET_PATH] = strToU8(
    patchSheetXml(strFromU8(sheet), walksRowsXml(rows), lastRow),
  );
  entries[CHART_PATH] = strToU8(patchChartXml(strFromU8(chart), lastRow));
  return zipSync(entries, { level: 6 });
}

/**
 * Browser entry: fetch the committed template, fill it, hand back the file
 * bytes. Rejects on a missing template / moved internals — the caller owns
 * the user-facing failure surface.
 */
export async function buildWalksXlsx(
  rows: ReadonlyArray<ReadonlyArray<XlsxCell>>,
): Promise<Uint8Array> {
  const res = await fetch("export-template.xlsx");
  if (!res.ok) {
    throw new Error(`export-template fetch failed: ${res.status}`);
  }
  return fillWalksTemplate(new Uint8Array(await res.arrayBuffer()), rows);
}
