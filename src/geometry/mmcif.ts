import type { Atom } from "./pdb";
import { VDW_RADII, DEFAULT_RADIUS } from "./pdb";

/**
 * Tokenizes one line of mmCIF data-row text, honoring quoted strings
 * (`'...'` / `"..."`, which may contain spaces — a closing quote only
 * counts if followed by whitespace or end-of-line, per the CIF spec,
 * distinguishing e.g. `O5'` — a real atom name with an embedded quote —
 * from an actual quoted-string terminator).
 */
function tokenizeCifLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && !(line[j] === ch && (j + 1 >= n || /\s/.test(line[j + 1])))) j++;
      tokens.push(line.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < n && !/\s/.test(line[j])) j++;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

/**
 * Parses atom coordinates out of an mmCIF file's `_atom_site` loop — the
 * modern replacement for fixed-column PDB format, which RCSB now treats
 * as legacy (no atom-count/column-width limits, unlike PDB). Finds the
 * `loop_` block whose header tags start with `_atom_site.`, reads its
 * column order (mmCIF loops declare columns as a header list, not a fixed
 * layout — position varies file to file, unlike PDB's fixed columns), and
 * reads each subsequent whitespace/quote-tokenized data row until the
 * loop ends (blank line, `#`, a new tag, or a new loop_/data_ block).
 * Prefers `auth_asym_id` (the author-assigned chain letters papers and
 * viewers actually show) over `label_asym_id` (an internal id that often
 * splits/renumbers the same visual chain) for chain grouping.
 */
export function parseCIFAtoms(cifText: string, onProgress?: (fraction: number) => void): Atom[] {
  const lines = cifText.split("\n");
  const atoms: Atom[] = [];
  let i = 0;
  // Reported every REPORT_INTERVAL lines rather than every line — this
  // runs in the worker now specifically so a large file's tokenization
  // (character-by-character, quote-aware — see tokenizeCifLine — much
  // heavier per line than PDB's fixed-column slicing) doesn't block
  // anything with no feedback the way it used to on the main thread, but
  // posting a worker message every single line would just trade one
  // bottleneck for another.
  const REPORT_INTERVAL = 5000;

  while (i < lines.length) {
    if (lines[i].trim() !== "loop_") {
      i++;
      continue;
    }

    let j = i + 1;
    const headers: string[] = [];
    while (j < lines.length && lines[j].trim().startsWith("_")) {
      headers.push(lines[j].trim());
      j++;
    }

    if (headers.length === 0 || !headers[0].startsWith("_atom_site.")) {
      i = j;
      continue;
    }

    const colIndex = (suffix: string) => headers.indexOf(`_atom_site.${suffix}`);
    const ixGroup = colIndex("group_PDB");
    const ixElement = colIndex("type_symbol");
    const ixX = colIndex("Cartn_x");
    const ixY = colIndex("Cartn_y");
    const ixZ = colIndex("Cartn_z");
    const ixChainAuth = colIndex("auth_asym_id");
    const ixChainLabel = colIndex("label_asym_id");
    const ixChain = ixChainAuth >= 0 ? ixChainAuth : ixChainLabel;

    let k = j;
    while (k < lines.length) {
      // Checked inside the per-atom-row loop, not just the outer one — a
      // real structure file is typically ONE large _atom_site loop, so
      // this is where almost all of a large file's lines (and tokenizing
      // cost) actually are.
      if (k % REPORT_INTERVAL === 0) onProgress?.(k / lines.length);

      const raw = lines[k];
      const trimmed = raw.trim();
      if (trimmed === "" || trimmed === "#" || trimmed.startsWith("_") || trimmed === "loop_" || trimmed.startsWith("data_")) break;

      const tokens = tokenizeCifLine(raw);
      if (tokens.length >= headers.length && ixX >= 0 && ixY >= 0 && ixZ >= 0) {
        const group = ixGroup >= 0 ? tokens[ixGroup] : "ATOM";
        if (group === "ATOM" || group === "HETATM") {
          const x = parseFloat(tokens[ixX]);
          const y = parseFloat(tokens[ixY]);
          const z = parseFloat(tokens[ixZ]);
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            const element = (ixElement >= 0 ? tokens[ixElement] : "C").toUpperCase();
            const chain = ixChain >= 0 ? tokens[ixChain] : "_";
            atoms.push({ x, y, z, radius: VDW_RADII[element] ?? DEFAULT_RADIUS, chain });
          }
        }
      }
      k++;
    }

    i = k;
  }

  return atoms;
}
