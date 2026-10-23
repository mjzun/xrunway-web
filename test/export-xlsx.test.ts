import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  escapeXml,
  fillWalksTemplate,
  patchChartXml,
  patchSheetXml,
  walksRowsXml,
} from "../src/export-xlsx.ts";
import {
  HISTORY_EXPORT_HEADERS,
  historyRowCells,
  historyToCsv,
  type SessionSummaryRow,
} from "../src/session-recorder.ts";

// The charted walks Excel export: the committed template
// (public/export-template.xlsx, scripts/gen-export-template.py) + the
// browser fill (src/export-xlsx.ts). These tests run the REAL fill against
// the REAL committed bytes — the template's internals (sheet path, header
// row, the $201 chart ranges) are drift-pinned here so a regenerated
// template that moves them goes red before any trainee's export breaks.

const TEMPLATE = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../public/export-template.xlsx", import.meta.url)),
  ),
);

const template = unzipSync(TEMPLATE);
const sheetXml = strFromU8(template["xl/worksheets/sheet1.xml"]);
const chartXml = strFromU8(template["xl/charts/chart1.xml"]);

function row(over: Partial<SessionSummaryRow> = {}): SessionSummaryRow {
  return {
    id: "w1",
    startedAt: Date.UTC(2026, 6, 8, 15, 4), // 2026-07-08 15:04 UTC
    lesson: "BEGINNER WALK",
    primarySource: "head",
    durationSec: 20,
    overall: 86.4,
    finalScores: {
      pace: 88.2,
      posture: 70,
      rhythm: 75,
      presence: 80,
      footPlacement: 91.7,
      confidence: 82,
      presentation: 84,
    },
    carriage: {
      carriageScore: 77.5,
    } as unknown as SessionSummaryRow["carriage"],
    runwayLength: 7.04,
    runwayWidth: 1.4,
    shapeKind: "straight",
    ...over,
  };
}

describe("the committed template (drift pins)", () => {
  it("row 1 is EXACTLY the founder-locked eleven headers, in order", () => {
    const texts = [...sheetXml.matchAll(/<is><t>([^<]*)<\/t><\/is>/g)].map(
      (m) => m[1],
    );
    expect(texts).toEqual([...HISTORY_EXPORT_HEADERS]);
  });

  it("the sheet is WALKS with only the header row (dimension A1:K1)", () => {
    expect(sheetXml).toContain('<dimension ref="A1:K1" />');
    const workbook = strFromU8(template["xl/workbook.xml"]);
    expect(workbook).toContain('name="WALKS"');
  });

  it("the chart plots overall/pace/carriage/line (H..K) over the date column, ranges to $201", () => {
    for (const col of ["H", "I", "J", "K"]) {
      expect(chartXml).toContain(`'WALKS'!$${col}$2:$${col}$201`);
    }
    expect(chartXml).toContain("'WALKS'!$A$2:$A$201"); // categories = date
    expect(chartXml).toContain('dispBlanksAs val="gap"'); // blanks never read 0
    // Exactly four series, names from the header row — duration_s (G) is
    // data, NEVER a series: the Y axis is the 0-100 score scale and a
    // 10-60 s line would misread as a score.
    expect(chartXml.match(/<ser>/g)).toHaveLength(4);
    expect(chartXml).not.toContain("$G$2:$G$201");
    for (const head of ["H1", "I1", "J1", "K1"]) {
      expect(chartXml).toContain(`'WALKS'!${head}`);
    }
  });
});

describe("walksRowsXml", () => {
  it("numbers chart (numeric cells), strings are inline text, blanks are omitted", () => {
    const xml = walksRowsXml([
      ["2026-07-08", "15:04", "BEGINNER WALK", 7, 1.4, "straight", 86, 88, "", 92],
    ]);
    expect(xml).toContain('<c r="A2" t="inlineStr"><is><t>2026-07-08</t></is></c>');
    expect(xml).toContain('<c r="G2"><v>86</v></c>');
    expect(xml).not.toContain('r="I2"'); // empty carriage -> no cell at all
    expect(xml.startsWith('<row r="2">')).toBe(true);
  });

  it("escapes XML in string cells (never executes as a formula — text cells)", () => {
    const xml = walksRowsXml([["<b>&\"</b>", "", "", "", "", "", "", "", "", ""]]);
    expect(xml).toContain("&lt;b&gt;&amp;&quot;&lt;/b&gt;");
    expect(escapeXml("a&b<c>")).toBe("a&amp;b&lt;c&gt;");
  });
});

describe("patchers", () => {
  it("patchSheetXml inserts rows + re-fits the dimension", () => {
    const out = patchSheetXml(sheetXml, '<row r="2"></row>', 2);
    expect(out).toContain('<dimension ref="A1:K2" />');
    expect(out).toContain('<row r="2"></row></sheetData>');
  });

  it("patchChartXml re-fits every $201 to the actual last row", () => {
    const out = patchChartXml(chartXml, 4);
    expect(out).not.toContain("$201");
    expect(out).toContain("'WALKS'!$H$2:$H$4");
    expect(out).toContain("'WALKS'!$A$2:$A$4");
  });

  it("both throw on a template whose internals moved (fail loud, not corrupt)", () => {
    expect(() => patchSheetXml("<x/>", "", 2)).toThrow(/sheetData/);
    expect(() => patchChartXml("<x/>", 2)).toThrow(/\$201/);
  });
});

describe("fillWalksTemplate (the REAL fill against the REAL template)", () => {
  // Row 1 predates the duration wave (no walkSecondsSet -> blank duration_s);
  // row 2 carries the configured 45 s stamp.
  const rows = [
    row(),
    row({
      startedAt: Date.UTC(2026, 6, 8, 16, 30),
      overall: 91,
      walkSecondsSet: 45,
    }),
  ];
  const cells = rows.map(historyRowCells);
  const filled = unzipSync(fillWalksTemplate(TEMPLATE, cells));

  it("writes the SAME values the founder-locked CSV carries (single source)", () => {
    const outSheet = strFromU8(filled["xl/worksheets/sheet1.xml"]);
    // Cross-check against the CSV lines for the same rows — the no-drift law.
    const csvLines = historyToCsv(rows).split("\n");
    expect(csvLines[1]).toBe(
      "2026-07-08,15:04,BEGINNER WALK,7,1.4,straight,,86,88,78,92",
    );
    expect(csvLines[2]).toBe(
      "2026-07-08,16:30,BEGINNER WALK,7,1.4,straight,45,91,88,78,92",
    );
    expect(outSheet).toContain("<is><t>2026-07-08</t></is>");
    expect(outSheet).toContain("<is><t>15:04</t></is>");
    expect(outSheet).toContain("<is><t>BEGINNER WALK</t></is>");
    expect(outSheet).toContain('<c r="H2"><v>86</v></c>'); // overall
    expect(outSheet).toContain('<c r="J2"><v>78</v></c>'); // carriage
    expect(outSheet).toContain('<c r="K2"><v>92</v></c>'); // line
    // Legacy row 2 has NO duration cell (blank, chart-gap law)...
    expect(outSheet).not.toContain('<c r="G2"');
    // ...while the stamped row carries the configured 45 at G.
    expect(outSheet).toContain('<c r="G3"><v>45</v></c>');
    expect(outSheet).toContain('<c r="H3"><v>91</v></c>');
    expect(outSheet).toContain('<dimension ref="A1:K3" />');
  });

  it("re-fits the chart to exactly the exported rows", () => {
    const outChart = strFromU8(filled["xl/charts/chart1.xml"]);
    expect(outChart).toContain("'WALKS'!$H$2:$H$3");
    expect(outChart).not.toContain("$201");
  });

  it("preserves every other archive entry byte-for-byte", () => {
    for (const path of Object.keys(template)) {
      expect(filled[path]).toBeDefined();
      if (path !== "xl/worksheets/sheet1.xml" && path !== "xl/charts/chart1.xml") {
        expect(Buffer.from(filled[path]).equals(Buffer.from(template[path]))).toBe(
          true,
        );
      }
    }
  });
});
