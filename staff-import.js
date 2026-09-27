export const CSV_TEMPLATE = "name,role\nMaria Santos,staff\nJohn Cruz,staff\nAna Reyes,manager\n";

function csvRows(text) {
  const rows = [], row = [];
  let cell = "", quoted = false;
  const input = String(text).replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(cell); cell = ""; }
    else if (character === '\n') { row.push(cell.replace(/\r$/, "")); rows.push(row.splice(0)); cell = ""; }
    else cell += character;
  }
  if (quoted) throw new Error("Unclosed quoted field.");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseStaffCsv(text) {
  const rows = csvRows(text).filter(row => row.some(cell => cell.trim()));
  if (!rows.length) throw new Error("CSV is empty.");
  const header = rows.shift().map(cell => cell.trim().toLowerCase());
  const nameIndex = header.indexOf("name"), roleIndex = header.indexOf("role");
  if (header.length !== 2 || nameIndex < 0 || roleIndex < 0 || header.filter(value => value === "name").length !== 1 || header.filter(value => value === "role").length !== 1) throw new Error("CSV must contain exactly name and role columns.");
  const seen = new Set();
  const entries = rows.map((cells, index) => {
    const name = (cells[nameIndex] || "").trim(), role = (cells[roleIndex] || "").trim().toLowerCase(), errors = [];
    if (cells.length !== 2) errors.push("Malformed row");
    if (!name || name.length > 80) errors.push("Name must be 1–80 characters");
    if (!['staff', 'manager'].includes(role)) errors.push("Role must be staff or manager");
    const key = name.toLowerCase() + "|" + role;
    if (!errors.length && seen.has(key)) errors.push("Duplicate row in this file");
    seen.add(key);
    return { row: index + 2, name, role, errors, ready: !errors.length };
  });
  return { entries, valid: entries.filter(entry => entry.ready), invalid: entries.filter(entry => !entry.ready) };
}

export async function createImportedStaff(entries, register) {
  const results = [];
  for (const entry of entries) {
    try { results.push({ ...entry, ok: true, code: await register(entry.name, entry.role) }); }
    catch (error) { results.push({ ...entry, ok: false, error: error.message || String(error) }); }
  }
  return results;
}
