import * as XLSX from "xlsx";

export function sheetToRows(buf: ArrayBuffer): any[][] {
  const wb = XLSX.read(buf, { type: "array", raw: false, cellText: true });
  const name = wb.SheetNames[0];
  if (!name) return [];
  const sheet = wb.Sheets[name];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false }) as any[][];
}

export function rowsToXlsx(headers: string[], rows: (string | number)[][], sheetName = "Sheet1"): ArrayBuffer {
  const aoa = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // force text for all cells
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = ws[addr];
      if (!cell) continue;
      cell.t = "s";
      cell.v = String(cell.v ?? "");
      cell.z = "@";
    }
  }
  // RTL view
  if (!ws["!views"]) ws["!views"] = [];
  (ws as any)["!views"] = [{ rightToLeft: true }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
  return out.buffer;
}

export function xlsxResponse(buf: ArrayBuffer, filename: string): Response {
  return new Response(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
