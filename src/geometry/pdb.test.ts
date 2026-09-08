import { describe, it, expect } from "vitest";
import { parsePDBAtoms, groupAtomsByChain, computeSESField, voxelizeAtoms } from "./pdb";
import { voxelIndex } from "./voxelize";

/** Builds a fixed-column PDB ATOM/HETATM line by placing fields at the
 * exact 0-indexed offsets parsePDBAtoms reads from (cols 13-16 for name,
 * 22 for chain, 31-38/39-46/47-54 for x/y/z, 77-78 for element),
 * independent of whether the string "looks like" a real PDB line. */
function makeAtomLine(opts: { record?: string; name: string; chain?: string; x: number; y: number; z: number; element?: string }): string {
  const chars = new Array(80).fill(" ");
  const put = (str: string, start: number) => {
    for (let i = 0; i < str.length; i++) chars[start + i] = str[i];
  };
  put((opts.record ?? "ATOM").padEnd(6), 0);
  put(opts.name.padStart(4), 12);
  if (opts.chain) put(opts.chain, 21);
  const fmt = (n: number) => n.toFixed(3).padStart(8);
  put(fmt(opts.x), 30);
  put(fmt(opts.y), 38);
  put(fmt(opts.z), 46);
  if (opts.element) put(opts.element.padStart(2), 76);
  return chars.join("");
}

describe("parsePDBAtoms", () => {
  it("parses ATOM and HETATM coordinates, skipping other record types", () => {
    const text = [
      makeAtomLine({ name: "N", x: 11.104, y: 6.134, z: -6.504, element: "N" }),
      makeAtomLine({ record: "HETATM", name: "ZN", x: 20, y: 10, z: 5, element: "ZN" }),
      "REMARK   2 not an atom record",
    ].join("\n");

    const atoms = parsePDBAtoms(text);
    expect(atoms).toHaveLength(2);
    expect(atoms[0].x).toBeCloseTo(11.104, 3);
    expect(atoms[0].y).toBeCloseTo(6.134, 3);
    expect(atoms[0].z).toBeCloseTo(-6.504, 3);
    expect(atoms[1].x).toBeCloseTo(20, 3);
  });

  it("assigns element-specific van der Waals radii from the element column", () => {
    const text = [
      makeAtomLine({ name: "N", x: 0, y: 0, z: 0, element: "N" }),
      makeAtomLine({ name: "C", x: 0, y: 0, z: 0, element: "C" }),
      makeAtomLine({ record: "HETATM", name: "ZN", x: 0, y: 0, z: 0, element: "ZN" }),
    ].join("\n");

    const [n, c, zn] = parsePDBAtoms(text);
    expect(n.radius).toBeCloseTo(1.55, 2);
    expect(c.radius).toBeCloseTo(1.7, 2);
    expect(zn.radius).toBeCloseTo(1.39, 2);
  });

  it("falls back to the atom name when the element column is blank", () => {
    // Older PDB files omit columns 77-78; "OG" (serine side-chain oxygen)
    // isn't itself a known element symbol, so this should fall back to "O".
    const text = makeAtomLine({ name: "OG", x: 1, y: 2, z: 3 });
    const atoms = parsePDBAtoms(text);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].radius).toBeCloseTo(1.52, 2);
  });

  it("returns an empty list for text with no atom records", () => {
    expect(parsePDBAtoms("HEADER    SOMETHING\nEND")).toHaveLength(0);
  });

  it("reads the chain identifier, defaulting to a placeholder when blank", () => {
    const text = [
      makeAtomLine({ name: "N", chain: "A", x: 0, y: 0, z: 0 }),
      makeAtomLine({ name: "N", chain: "B", x: 0, y: 0, z: 0 }),
      makeAtomLine({ name: "N", x: 0, y: 0, z: 0 }),
    ].join("\n");
    const atoms = parsePDBAtoms(text);
    expect(atoms.map((a) => a.chain)).toEqual(["A", "B", "_"]);
  });
});

describe("parsePDBAtoms MODEL handling", () => {
  /** A legacy-PDB biological assembly ({ID}.pdb1): the chain column is one
   * character, so symmetry copies reuse the same letters and are separated
   * by MODEL blocks instead — see parsePDBAtoms' doc comment. */
  function makeModelLine(n: number): string {
    const chars = new Array(80).fill(" ");
    const put = (s: string, start: number) => { for (let i = 0; i < s.length; i++) chars[start + i] = s[i]; };
    put("MODEL ", 0);
    put(String(n).padStart(4), 10);
    return chars.join("");
  }

  it("suffixes chains past the first model so symmetry copies stay distinct", () => {
    const text = [
      makeModelLine(1),
      makeAtomLine({ name: "N", chain: "A", x: 0, y: 0, z: 0 }),
      makeAtomLine({ name: "N", chain: "B", x: 1, y: 0, z: 0 }),
      "ENDMDL",
      makeModelLine(2),
      makeAtomLine({ name: "N", chain: "A", x: 50, y: 0, z: 0 }),
      makeAtomLine({ name: "N", chain: "B", x: 51, y: 0, z: 0 }),
      "ENDMDL",
      makeModelLine(3),
      makeAtomLine({ name: "N", chain: "A", x: 100, y: 0, z: 0 }),
      makeAtomLine({ name: "N", chain: "B", x: 101, y: 0, z: 0 }),
      "ENDMDL",
    ].join("\n");

    const atoms = parsePDBAtoms(text);
    expect(atoms).toHaveLength(6);
    // Matches mmCIF's own assembly naming (A, A-2, A-3), so the same
    // structure gets the same chain identities in either format.
    expect([...groupAtomsByChain(atoms).keys()].sort()).toEqual(["A", "A-2", "A-3", "B", "B-2", "B-3"]);
    // Coordinates must survive untouched — only the label changes.
    expect(atoms[4].x).toBeCloseTo(100, 3);
    expect(atoms[4].chain).toBe("A-3");
  });

  it("leaves chain names alone for an ordinary single-model file", () => {
    const text = [
      makeAtomLine({ name: "N", chain: "A", x: 0, y: 0, z: 0 }),
      makeAtomLine({ name: "N", chain: "B", x: 1, y: 0, z: 0 }),
    ].join("\n");
    expect([...groupAtomsByChain(parsePDBAtoms(text)).keys()]).toEqual(["A", "B"]);
  });

  it("still suffixes when a MODEL record carries no parsable serial", () => {
    const text = ["MODEL", makeAtomLine({ name: "N", chain: "A", x: 0, y: 0, z: 0 }),
      "ENDMDL", "MODEL", makeAtomLine({ name: "N", chain: "A", x: 9, y: 0, z: 0 }), "ENDMDL"].join("\n");
    const chains = [...groupAtomsByChain(parsePDBAtoms(text)).keys()];
    expect(chains).toHaveLength(2);
    expect(chains[0]).toBe("A");
  });
});

describe("groupAtomsByChain", () => {
  it("groups atoms by chain in first-seen order", () => {
    const text = [
      makeAtomLine({ name: "N", chain: "B", x: 0, y: 0, z: 0 }),
      makeAtomLine({ name: "N", chain: "A", x: 1, y: 0, z: 0 }),
      makeAtomLine({ name: "N", chain: "B", x: 2, y: 0, z: 0 }),
    ].join("\n");
    const groups = groupAtomsByChain(parsePDBAtoms(text));
    expect([...groups.keys()]).toEqual(["B", "A"]);
    expect(groups.get("B")).toHaveLength(2);
    expect(groups.get("A")).toHaveLength(1);
  });
});

describe("computeSESField", () => {
  // A single atom's SES has no reentrant patches to bridge, so near its
  // own surface it should equal the raw vdW field exactly (see pdb.ts's
  // computeSESField doc comment for the derivation). That equivalence only
  // holds inside the SAS shell (within one probe radius of the vdW
  // surface) — a voxel already out in bulk solvent is, by definition,
  // itself a "distance-0" solvent point, so sesField saturates at exactly
  // `probeRadius` out there instead of continuing to grow with distance
  // the way the unbounded vdW field does. That saturation is expected
  // (marching cubes never looks at field values far from the zero
  // crossing), not a bug — both tests below check for it explicitly.
  // Grid half-width must clear radius+probeRadius with real margin — a
  // grid whose edge sits right at that boundary leaves corner/edge voxels
  // with no genuine nearby solvent voxel along some directions (the
  // nearest one ends up diagonally across the grid instead of just
  // outside the surface), which is a test-fixture artifact, not a real
  // SES-field bug: real voxelizeAtoms always pads PAD extra empty voxels
  // well beyond radius+probeRadius.
  const nx = 31, ny = 31, nz = 31;
  const voxelSize = 0.3;
  const center = 15;
  const radius = 1.7;
  const probeRadius = 1.4;

  function buildIsolatedAtomVdwField(): Float32Array {
    const vdwField = new Float32Array(nx * ny * nz);
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const dx = (x - center) * voxelSize;
          const dy = (y - center) * voxelSize;
          const dz = (z - center) * voxelSize;
          vdwField[voxelIndex({ nx, ny, nz } as any, x, y, z)] = Math.sqrt(dx * dx + dy * dy + dz * dz) - radius;
        }
      }
    }
    return vdwField;
  }

  it("matches the van der Waals field within one probe radius of the surface", () => {
    // Tolerance is physically motivated, not arbitrary: the solvent mask
    // (and so the nearest-marked-voxel distance the SES field is built
    // from) is only known to one voxel's resolution, so up to ~1 voxel of
    // quantization error versus the continuous vdW field is expected.
    const vdwField = buildIsolatedAtomVdwField();
    const sesField = computeSESField(vdwField, nx, ny, nz, probeRadius, voxelSize);
    for (let i = 0; i < vdwField.length; i++) {
      if (vdwField[i] <= probeRadius) expect(Math.abs(sesField[i] - vdwField[i])).toBeLessThan(1.5 * voxelSize);
    }
  });

  it("saturates at exactly probeRadius out in bulk solvent, away from the surface", () => {
    const vdwField = buildIsolatedAtomVdwField();
    const sesField = computeSESField(vdwField, nx, ny, nz, probeRadius, voxelSize);
    for (let i = 0; i < vdwField.length; i++) {
      if (vdwField[i] > probeRadius) expect(sesField[i]).toBeCloseTo(probeRadius, 5);
    }
  });
});

describe("voxelizeAtoms", () => {
  it("produces a solid (negative-field) region roughly matching the atom's own volume", () => {
    const atoms = [{ x: 0, y: 0, z: 0, radius: 2, chain: "A" }];
    const grid = voxelizeAtoms(atoms, 20);
    expect(grid.field).toBeDefined();

    // Center voxel must be deeply inside (very negative field).
    const cx = Math.round((0 - grid.origin.x) / grid.voxelSize);
    const cy = Math.round((0 - grid.origin.y) / grid.voxelSize);
    const cz = Math.round((0 - grid.origin.z) / grid.voxelSize);
    expect(grid.field![voxelIndex(grid, cx, cy, cz)]).toBeLessThan(-1);

    // A far corner of the grid must be clearly outside (positive field).
    expect(grid.field![voxelIndex(grid, 0, 0, 0)]).toBeGreaterThan(0);
  });

  it("accepts an explicit voxelSize instead of deriving one from resolution", () => {
    const atoms = [{ x: 0, y: 0, z: 0, radius: 2, chain: "A" }];
    const grid = voxelizeAtoms(atoms, 20, 1.4, 0.5);
    expect(grid.voxelSize).toBe(0.5);
  });
});
