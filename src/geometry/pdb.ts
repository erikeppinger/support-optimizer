import * as THREE from "three";
import type { VoxelGrid } from "./voxelize";
import { PAD } from "./voxelize";
import { marchingCubes } from "./marching-cubes";
import { distanceTransform3D } from "./distance-transform";
import { CHAIN_PALETTES } from "./chain-palettes";

export interface Atom {
  x: number;
  y: number;
  z: number;
  radius: number;
  chain: string;
}

// Element van-der-Waals radii (Angstroms), covering the elements that
// actually turn up in PDB ATOM/HETATM records for proteins/nucleic acids
// plus the common crystallographic ions. Exported so mmcif.ts (the other
// atom-record format this app reads) shares the same table rather than
// keeping a second copy that could drift out of sync.
export const VDW_RADII: Record<string, number> = {
  H: 1.2, C: 1.7, N: 1.55, O: 1.52, S: 1.8, P: 1.8,
  F: 1.47, CL: 1.75, BR: 1.85, I: 1.98,
  NA: 2.27, MG: 1.73, K: 2.75, CA: 2.31, ZN: 1.39, FE: 2.0, MN: 2.0,
};
export const DEFAULT_RADIUS = 1.7;

/** Water probe radius (Angstroms) used for Solvent Excluded Surface
 * computation — the universal default in PyMOL, ChimeraX, MSMS, etc. */
export const DEFAULT_PROBE_RADIUS = 1.4;

/** Crystallographic/cryo-EM water residue names, in every spelling that
 * actually shows up in deposited PDB/mmCIF files (HOH is overwhelmingly
 * the modern standard; the rest are older or neutron-structure variants).
 * Excluded from the surface build unconditionally — unlike an ion or a
 * bound ligand, a water carries no structural information anyone prints
 * a model to show, and a single isolated one (common in a solvent
 * channel or buried pocket) becomes its own tiny watertight blob,
 * disconnected from the main surface, once voxelized. A slicer then has
 * no way to tell that apart from a real tiny part — it just sees a small
 * island floating inside the print with nothing to rest on, and adds
 * support material to hold IT up too. Exported so mmcif.ts shares the
 * same list rather than keeping a second copy that could drift. */
export const WATER_RESIDUE_NAMES = new Set(["HOH", "WAT", "H2O", "DOD"]);

/** Options shared by both parsePDBAtoms and parseCIFAtoms. */
export interface ParseAtomsOptions {
  /** Non-water HETATM/heteroatom records — ions, bound ligands, buffer
   * or cryoprotectant molecules. Default true (kept), matching this
   * app's behavior before this option existed. Water is always excluded
   * regardless of this setting (see WATER_RESIDUE_NAMES) since it never
   * carries structural/display value; a heteroatom is more of a
   * judgment call — a bound ligand can be exactly what someone wants
   * shown — but the same failure mode applies: an ion or small molecule
   * sitting apart from the main structure (loose in the solvent region,
   * not actually bound) becomes its own tiny surface fragment,
   * disconnected from everything else, once voxelized — precisely the
   * water problem again, just for a different residue type. Surfaced as
   * a user-facing choice rather than a hardcoded default because,
   * unlike water, there's no single right answer for every structure. */
  includeHeteroatoms?: boolean;
}

/**
 * Parses ATOM/HETATM records from PDB fixed-column text into atom centers,
 * van-der-Waals radii, and chain identifiers — excluding water records
 * (see WATER_RESIDUE_NAMES) and, unless `includeHeteroatoms` is set,
 * every other HETATM record too; residue name is column 18-20. Element
 * comes from columns 77-78 when present (modern PDB files); older files
 * omit it, so this falls back to stripping digits from the atom name
 * (columns 13-16) the way most PDB tooling does. Chain ID is column 22.
 *
 * MODEL records matter for biological-assembly downloads (`{ID}.pdb1`):
 * the chain ID column is a single character, so a symmetry-expanded
 * assembly cannot give its copies distinct letters the way mmCIF's
 * `auth_asym_id` does (which yields A, A-2, A-3). Legacy PDB instead puts
 * each symmetry copy in its own MODEL block, reusing the same chain
 * letters. Suffixing the chain with the model number past the first
 * reproduces mmCIF's exact naming, so the same assembly gets the same
 * per-copy chain identity — and therefore the same subunit coloring and
 * chain-subset entries — in either format. An ordinary multi-model file
 * (an NMR ensemble) has all its models superimposed rather than placed
 * apart, but the same suffixing keeps them individually selectable, which
 * is the useful behavior there too.
 */
export function parsePDBAtoms(pdbText: string, onProgress?: (fraction: number) => void, options: ParseAtomsOptions = {}): Atom[] {
  const { includeHeteroatoms = true } = options;
  const atoms: Atom[] = [];
  let modelNumber = 1;
  let modelsSeen = 0;
  const lines = pdbText.split("\n");
  const REPORT_INTERVAL = 20000;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (lineIndex % REPORT_INTERVAL === 0) onProgress?.(lineIndex / lines.length);
    const line = lines[lineIndex];
    if (line.startsWith("MODEL")) {
      // Count models independently of the declared serial so a file with
      // missing/garbled serials still numbers from 1 (leaving the first
      // model's chains unsuffixed) rather than starting at 2.
      modelsSeen++;
      const parsed = parseInt(line.slice(10, 14).trim(), 10);
      modelNumber = Number.isFinite(parsed) ? parsed : modelsSeen;
      continue;
    }
    const isHetatm = line.startsWith("HETATM");
    if (!line.startsWith("ATOM") && !isHetatm) continue;
    if (isHetatm) {
      if (WATER_RESIDUE_NAMES.has(line.slice(17, 20).trim().toUpperCase())) continue;
      if (!includeHeteroatoms) continue;
    }
    const x = parseFloat(line.slice(30, 38));
    const y = parseFloat(line.slice(38, 46));
    const z = parseFloat(line.slice(46, 54));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    let element = line.slice(76, 78).trim().toUpperCase();
    if (!element) {
      const name = line.slice(12, 16).trim().replace(/[0-9]/g, "");
      element = name.slice(0, 2).toUpperCase();
      if (!VDW_RADII[element]) element = name.slice(0, 1).toUpperCase();
    }
    const baseChain = line.slice(21, 22).trim() || "_";
    const chain = modelNumber > 1 ? `${baseChain}-${modelNumber}` : baseChain;
    atoms.push({ x, y, z, radius: VDW_RADII[element] ?? DEFAULT_RADIUS, chain });
  }
  return atoms;
}

/** Groups atoms by chain, preserving first-seen chain order (so output
 * ordering is stable/deterministic run to run for the same file). */
export function groupAtomsByChain(atoms: Atom[]): Map<string, Atom[]> {
  const groups = new Map<string, Atom[]>();
  for (const atom of atoms) {
    let group = groups.get(atom.chain);
    if (!group) {
      group = [];
      groups.set(atom.chain, group);
    }
    group.push(atom);
  }
  return groups;
}

/**
 * Converts a van-der-Waals union signed-distance field into a Solvent
 * Excluded Surface (SES / Connolly surface) field, via the same
 * two-pass-distance-transform construction EDTSurf uses: a point is
 * "inside" the SES exactly when it is farther than `probeRadius` from
 * every solvent-accessible point (a point a probe sphere's CENTER could
 * occupy without clashing any atom). Concretely:
 *
 *   1. solventMask = vdwField > probeRadius   (probe center can sit here)
 *   2. D(p) = distance from p to the nearest solventMask voxel
 *   3. sesField(p) = probeRadius - D(p)         (negative = inside SES)
 *
 * This reduces to the vdW surface itself for an isolated atom (no
 * crevice for a probe to bridge), and bridges over gaps between nearby
 * atoms too narrow for the probe to enter — the "reentrant" patches that
 * make SES look like the smoothed, familiar molecular-surface rendering
 * from PyMOL/ChimeraX rather than a lumpy space-filling model.
 */
export function computeSESField(
  vdwField: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  probeRadius: number,
  voxelSize: number,
): Float32Array {
  const solventMask = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < vdwField.length; i++) {
    if (vdwField[i] > probeRadius) solventMask[i] = 1;
  }
  // distanceTransform3D works in voxel-index units (its 1D pass computes
  // (x-y)^2 over integer indices), not physical units — must scale by
  // voxelSize before comparing against probeRadius, which is in Angstroms.
  const distanceInVoxels = distanceTransform3D(solventMask, nx, ny, nz);
  const sesField = new Float32Array(distanceInVoxels.length);
  for (let i = 0; i < distanceInVoxels.length; i++) sesField[i] = probeRadius - distanceInVoxels[i] * voxelSize;
  return sesField;
}

/**
 * Voxelizes a set of atoms' van-der-Waals sphere union into a VoxelGrid
 * carrying a Solvent Excluded Surface field (see computeSESField), ready
 * for marchingCubes(). `voxelSize` may be supplied explicitly (used by
 * per-chain meshing, so every chain shares one consistent absolute
 * resolution regardless of its own size) — otherwise it's derived from
 * `targetResolution` voxels along this atom set's own longest axis, same
 * as the original van-der-Waals-only version.
 *
 * Each atom updates voxels within `radius + probeRadius` of its center
 * (not just `radius`) — the SES solvent-accessibility test needs accurate
 * field values out to one probe radius past the surface, not just at the
 * zero-crossing, or a voxel wedged in a crevice between two atoms but
 * untouched by either atom's own box would default to "far away" (i.e.
 * wrongly read as solvent-accessible) instead of reflecting how enclosed
 * it actually is.
 */
export function voxelizeAtoms(
  atoms: Atom[],
  targetResolution: number,
  probeRadius: number = DEFAULT_PROBE_RADIUS,
  voxelSize?: number,
): VoxelGrid {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const a of atoms) {
    const reach = a.radius + probeRadius;
    if (a.x - reach < minX) minX = a.x - reach;
    if (a.x + reach > maxX) maxX = a.x + reach;
    if (a.y - reach < minY) minY = a.y - reach;
    if (a.y + reach > maxY) maxY = a.y + reach;
    if (a.z - reach < minZ) minZ = a.z - reach;
    if (a.z + reach > maxZ) maxZ = a.z + reach;
  }

  const dimX = maxX - minX, dimY = maxY - minY, dimZ = maxZ - minZ;
  const maxDim = Math.max(dimX, dimY, dimZ, 1e-6);
  const vSize = voxelSize ?? maxDim / targetResolution;

  const nx = Math.ceil(dimX / vSize) + PAD * 2;
  const ny = Math.ceil(dimY / vSize) + PAD * 2;
  const nz = Math.ceil(dimZ / vSize) + PAD * 2;
  const origin = new THREE.Vector3(minX - PAD * vSize, minY - PAD * vSize, minZ - PAD * vSize);

  const solid = new Uint8Array(nx * ny * nz);
  // A large but FINITE sentinel for "no atom's local box reached this
  // voxel" — marching cubes' edge interpolation computes (vb - va), and
  // Infinity minus Infinity (two untouched neighboring voxels) or Infinity
  // minus a finite value produces NaN geometry, not just an imprecise
  // point. Any value far past voxelSize*grid-diagonal is equally "clearly
  // outside" for classification purposes without that hazard.
  const FAR = vSize * (nx + ny + nz);
  const vdwField = new Float32Array(nx * ny * nz).fill(FAR);
  const idx = (x: number, y: number, z: number) => (z * ny + y) * nx + x;

  for (const a of atoms) {
    const r = a.radius;
    const r2 = r * r;
    const reach = r + probeRadius;
    const ix0 = Math.max(0, Math.floor((a.x - reach - origin.x) / vSize));
    const ix1 = Math.min(nx - 1, Math.ceil((a.x + reach - origin.x) / vSize));
    const iy0 = Math.max(0, Math.floor((a.y - reach - origin.y) / vSize));
    const iy1 = Math.min(ny - 1, Math.ceil((a.y + reach - origin.y) / vSize));
    const iz0 = Math.max(0, Math.floor((a.z - reach - origin.z) / vSize));
    const iz1 = Math.min(nz - 1, Math.ceil((a.z + reach - origin.z) / vSize));

    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = origin.z + (iz + 0.5) * vSize - a.z;
      for (let iy = iy0; iy <= iy1; iy++) {
        const dy = origin.y + (iy + 0.5) * vSize - a.y;
        for (let ix = ix0; ix <= ix1; ix++) {
          const dx = origin.x + (ix + 0.5) * vSize - a.x;
          const d2 = dx * dx + dy * dy + dz * dz;
          const i = idx(ix, iy, iz);
          if (d2 <= r2) solid[i] = 1;
          const dist = Math.sqrt(d2) - r;
          if (dist < vdwField[i]) vdwField[i] = dist;
        }
      }
    }
  }

  const field = computeSESField(vdwField, nx, ny, nz, probeRadius, vSize);
  return { nx, ny, nz, voxelSize: vSize, origin, solid, field };
}

// The initial per-chain color at import time — always the default
// palette; see chain-palettes.ts for the other, colorblind-safe options
// main.ts lets the user switch to afterward (recolored client-side, from
// the chain index each vertex carries, without a rebuild).
const CHAIN_PALETTE = CHAIN_PALETTES.default;

export interface ChainMeshEntry {
  chain: string;
  color: [number, number, number];
  triangleStart: number;
  triangleCount: number;
}

export interface ChainMeshResult {
  position: Float32Array;
  normal: Float32Array;
  /** Per-vertex RGB in [0,1], one triplet per vertex — matches `position`
   * in length/indexing, ready to drop into a BufferGeometry "color"
   * attribute (or stash aside as "subunit color" and swap in later; see
   * main.ts's color-view toggle). */
  color: Float32Array;
  /** Which chain each range of triangles came from, and the color it was
   * assigned — used for the subunit-color legend and for regenerating
   * per-chain material groups on 3MF export. */
  chains: ChainMeshEntry[];
}

/**
 * Voxelizes and remeshes each chain independently (so chain boundaries
 * are exact, not an approximate nearest-atom guess at a shared surface),
 * then concatenates the results into one flat position/normal/color
 * buffer set. All chains share one voxel size — derived from the WHOLE
 * structure's own extent — so a small chain doesn't come out coarser or
 * finer than a large one; only the grid bounds are chain-local (each
 * chain gets its own tightly-fit box, not the whole structure's, which
 * keeps a small chain's grid small rather than mostly-empty padding).
 *
 * A single-chain structure (the common case) degenerates to exactly one
 * voxelize+remesh pass, same cost as the original whole-structure path.
 */
export function buildChainMeshes(
  atoms: Atom[],
  targetResolution: number,
  probeRadius: number = DEFAULT_PROBE_RADIUS,
  onProgress?: (fraction: number) => void,
): ChainMeshResult {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const a of atoms) {
    const reach = a.radius + probeRadius;
    if (a.x - reach < minX) minX = a.x - reach;
    if (a.x + reach > maxX) maxX = a.x + reach;
    if (a.y - reach < minY) minY = a.y - reach;
    if (a.y + reach > maxY) maxY = a.y + reach;
    if (a.z - reach < minZ) minZ = a.z - reach;
    if (a.z + reach > maxZ) maxZ = a.z + reach;
  }
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const voxelSize = maxDim / targetResolution;

  const groups = groupAtomsByChain(atoms);
  const chainIds = [...groups.keys()];

  const positions: Float32Array[] = [];
  const normals: Float32Array[] = [];
  const colors: Float32Array[] = [];
  const chains: ChainMeshEntry[] = [];
  let triangleOffset = 0;

  // Progress is weighted by each chain's own share of the total atom
  // count, not just its position in the chain list — a structure with one
  // huge chain and several tiny ones should track that huge chain's own
  // progress, not jump straight from (n-1)/n to 100% once it finishes.
  // Each chain also reports TWICE (after voxelizing, again after
  // remeshing) rather than once at the very end, so even a genuinely
  // single-chain structure — where "weighted by chain" alone still only
  // gives one tick — shows some movement partway through instead of
  // sitting at 0% for the entire voxelize+marching-cubes pass.
  const totalAtoms = atoms.length;
  let atomsBefore = 0;

  chainIds.forEach((chainId, i) => {
    const chainAtoms = groups.get(chainId)!;
    const grid = voxelizeAtoms(chainAtoms, targetResolution, probeRadius, voxelSize);
    onProgress?.((atomsBefore + chainAtoms.length * 0.4) / totalAtoms);

    const geometry = marchingCubes(grid);
    const position = geometry.attributes.position.array as Float32Array;
    const normal = geometry.attributes.normal.array as Float32Array;
    const vertexCount = position.length / 3;
    const triangleCount = vertexCount / 3;

    const color = CHAIN_PALETTE[i % CHAIN_PALETTE.length];
    const colorArray = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      colorArray[v * 3] = color[0];
      colorArray[v * 3 + 1] = color[1];
      colorArray[v * 3 + 2] = color[2];
    }

    positions.push(position);
    normals.push(normal);
    colors.push(colorArray);
    chains.push({ chain: chainId, color, triangleStart: triangleOffset, triangleCount });
    triangleOffset += triangleCount;
    atomsBefore += chainAtoms.length;
    onProgress?.(atomsBefore / totalAtoms);
  });

  const totalFloats = positions.reduce((sum, p) => sum + p.length, 0);
  const mergedPosition = new Float32Array(totalFloats);
  const mergedNormal = new Float32Array(totalFloats);
  const mergedColor = new Float32Array(totalFloats);
  let offset = 0;
  for (let i = 0; i < positions.length; i++) {
    mergedPosition.set(positions[i], offset);
    mergedNormal.set(normals[i], offset);
    mergedColor.set(colors[i], offset);
    offset += positions[i].length;
  }

  return { position: mergedPosition, normal: mergedNormal, color: mergedColor, chains };
}
