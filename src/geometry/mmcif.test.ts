import { describe, it, expect } from "vitest";
import { parseCIFAtoms } from "./mmcif";

// Shaped like a real RCSB mmCIF _atom_site loop (column order taken from
// an actual deposition) — deliberately NOT the same column order
// mmcif.ts's own logic assumes anywhere, so this test can't pass by
// accidentally matching a hardcoded position.
const SAMPLE_CIF = `data_TEST
#
_entry.id TEST
#
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_entity_id
_atom_site.label_seq_id
_atom_site.pdbx_PDB_ins_code
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.B_iso_or_equiv
_atom_site.pdbx_formal_charge
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_atom_id
_atom_site.pdbx_PDB_model_num
ATOM 1 N N . MET A 1 1 ? -3.331 10.288 16.667 1.00 45.00 ? 1 MET A N 1
ATOM 2 C CA . MET A 1 1 ? -2.552 9.058 16.409 1.00 44.00 ? 1 MET A CA 1
HETATM 3 ZN ZN . ZN B 2 . ? 20.000 10.000 5.000 1.00 20.00 ? 101 ZN B ZN 1
#
loop_
_struct_conf.id
_struct_conf.conf_type_id
HELX1 HELX_P
#
`;

describe("parseCIFAtoms", () => {
  it("parses ATOM and HETATM rows from the _atom_site loop", () => {
    const atoms = parseCIFAtoms(SAMPLE_CIF);
    expect(atoms).toHaveLength(3);
  });

  it("reads Cartn_x/y/z by column header, not fixed position", () => {
    const atoms = parseCIFAtoms(SAMPLE_CIF);
    expect(atoms[0].x).toBeCloseTo(-3.331, 3);
    expect(atoms[0].y).toBeCloseTo(10.288, 3);
    expect(atoms[0].z).toBeCloseTo(16.667, 3);
    expect(atoms[2].x).toBeCloseTo(20.0, 3);
  });

  it("assigns element-specific van der Waals radii from type_symbol", () => {
    const atoms = parseCIFAtoms(SAMPLE_CIF);
    expect(atoms[0].radius).toBeCloseTo(1.55, 2); // N
    expect(atoms[1].radius).toBeCloseTo(1.7, 2); // C
    expect(atoms[2].radius).toBeCloseTo(1.39, 2); // ZN
  });

  it("uses auth_asym_id for chain grouping", () => {
    const atoms = parseCIFAtoms(SAMPLE_CIF);
    expect(atoms[0].chain).toBe("A");
    expect(atoms[1].chain).toBe("A");
    expect(atoms[2].chain).toBe("B");
  });

  it("stops the loop at the next tag block and ignores unrelated loops", () => {
    // The trailing _struct_conf loop must not be misread as more atoms.
    const atoms = parseCIFAtoms(SAMPLE_CIF);
    expect(atoms).toHaveLength(3);
  });

  it("returns an empty list for text with no _atom_site loop", () => {
    expect(parseCIFAtoms("data_EMPTY\n#\n_entry.id EMPTY\n")).toHaveLength(0);
  });

  it("excludes water HETATM rows, but keeps other heteroatoms (ions, ligands)", () => {
    const withWater = SAMPLE_CIF.replace(
      "HETATM 3 ZN ZN . ZN B 2 . ? 20.000 10.000 5.000 1.00 20.00 ? 101 ZN B ZN 1\n",
      "HETATM 3 ZN ZN . ZN B 2 . ? 20.000 10.000 5.000 1.00 20.00 ? 101 ZN B ZN 1\n" +
        "HETATM 4 O O . HOH C 3 . ? 5.000 5.000 5.000 1.00 30.00 ? 201 HOH C O 1\n",
    );
    const atoms = parseCIFAtoms(withWater);
    // Still just the residue + the zinc ion — the water row is dropped.
    expect(atoms).toHaveLength(3);
    expect(atoms.some((a) => a.x === 5)).toBe(false);
  });

  it("includeHeteroatoms: false drops the zinc ion too, water still always dropped", () => {
    const atoms = parseCIFAtoms(SAMPLE_CIF, undefined, { includeHeteroatoms: false });
    // Only the two real ATOM rows (MET N, MET CA) survive — the HETATM zinc is dropped.
    expect(atoms).toHaveLength(2);
    expect(atoms.every((a) => a.x !== 20)).toBe(true);
  });

  it("handles a quoted token containing whitespace without misaligning columns", () => {
    const text =
      "loop_\n" +
      "_atom_site.group_PDB\n" +
      "_atom_site.type_symbol\n" +
      "_atom_site.label_comp_id\n" +
      "_atom_site.auth_asym_id\n" +
      "_atom_site.Cartn_x\n" +
      "_atom_site.Cartn_y\n" +
      "_atom_site.Cartn_z\n" +
      "ATOM C 'UNUSUAL NAME' A 1.0 2.0 3.0\n";
    const atoms = parseCIFAtoms(text);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].x).toBeCloseTo(1.0, 3);
    expect(atoms[0].chain).toBe("A");
  });
});
