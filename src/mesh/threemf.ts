import * as THREE from "three";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";

export interface Parsed3MF {
  /** Non-indexed, flat per-triangle positions — one unique vertex triple
   * per triangle corner, matching the STL/PDB pipeline's convention. */
  position: Float32Array;
  /** Per-vertex RGB in [0,1], same indexing as `position`. */
  color: Float32Array;
}

interface Vec3 { x: number; y: number; z: number; }

/** Row-vector 3x4 affine transform, per the 3MF spec's 12-number
 * "M00 M01 M02 M10 M11 M12 M20 M21 M22 M30 M31 M32" layout (last row is
 * translation): x' = x*a + y*d + z*g + j, and so on. */
function parseTransform(attr: string | null): (p: Vec3) => Vec3 {
  if (!attr) return (p) => p;
  const n = attr.trim().split(/\s+/).map(Number);
  if (n.length !== 12 || n.some((v) => !Number.isFinite(v))) return (p) => p;
  const [a, b, c, d, e, f, g, h, i, j, k, l] = n;
  return (p) => ({
    x: p.x * a + p.y * d + p.z * g + j,
    y: p.x * b + p.y * e + p.z * h + k,
    z: p.x * c + p.y * f + p.z * i + l,
  });
}

function parseHexColor(hex: string | null): [number, number, number] | null {
  if (!hex) return null;
  const m = /^#?([0-9a-fA-F]{6,8})$/.exec(hex.trim());
  if (!m) return null;
  const h = m[1];
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/**
 * PrusaSlicer's per-triangle multi-material-paint code table (identical for
 * Bambu Studio/OrcaSlicer, which write the same codes under a `paint_color`
 * attribute instead of `slic3rpe:mmu_segmentation`) — this is how a slicer's
 * OWN paint-on-supports/paint-on-color tool records a triangle's assigned
 * extruder, and it's what ChimeraX's 3MF exporter uses too (see the sibling
 * chimerax-3mf project) since it's the one per-triangle coloring mechanism
 * both PrusaSlicer and Bambu/Orca actually read back on import — unlike the
 * standards-compliant <m:colorgroup>/<basematerials> pid/p1 mechanism above,
 * which those slicers write but silently ignore when reading.
 *
 * Table and index offset (extruder N is MMU_CODES[N], index 0 = unpainted)
 * verified empirically by slicing known-volume test models — see
 * chimerax-3mf's CLAUDE.md ("the published MMU encoding tables are off by
 * one"). Only recognizes an EXACT, unsplit leaf code from this table; a
 * human paint job in the slicer itself can subdivide a triangle into a
 * quadtree of differently-colored sub-regions, serialized as a longer,
 * structurally different string this table can't represent — such a code
 * simply won't match here and that triangle falls through to whatever color
 * source comes next, rather than risk decoding it wrong.
 */
const MMU_SEGMENTATION_CODES = [
  "0", "4", "8", "0C", "1C", "2C", "3C", "4C",
  "5C", "6C", "7C", "8C", "9C", "AC", "BC", "CC",
];

function mmuSegmentationColor(
  code: string | null,
  palette: Array<[number, number, number] | null> | null,
): [number, number, number] | null {
  if (!code || !palette) return null;
  const idx = MMU_SEGMENTATION_CODES.indexOf(code.toUpperCase());
  if (idx <= 0) return null; // 0 = unpainted; -1 = not a recognized unsplit leaf code
  return palette[idx - 1] ?? null;
}

/**
 * Parses a 3MF file (a ZIP containing 3D/3dmodel.model XML, per the Core
 * and Materials & Properties specs) into a flat, non-indexed triangle soup
 * with per-vertex color. Supports both <basematerials> (name+displaycolor)
 * and the <m:colorgroup> color extension for per-triangle/per-object
 * coloring, <components> (objects built from other objects) recursively,
 * and <build><item transform="..."> placement. Falls back to each
 * triangle's slic3rpe:mmu_segmentation/paint_color code (see
 * mmuSegmentationColor) when no pid/p1 color is present — many real-world
 * 3MF writers (ChimeraX's own exporter included) paint color exclusively
 * through that per-triangle slicer-paint mechanism, since PrusaSlicer and
 * Bambu/Orca read it back but ignore <m:colorgroup>/<basematerials> on
 * import despite writing them too. Objects/triangles with no resolvable
 * color fall back to a neutral gray rather than failing.
 */
export function parse3MF(buffer: ArrayBuffer): Parsed3MF {
  const files = unzipSync(new Uint8Array(buffer));
  const modelPath = Object.keys(files).find((p) => /^3D\/.*\.model$/i.test(p)) ?? "3D/3dmodel.model";
  const modelBytes = files[modelPath];
  if (!modelBytes) throw new Error("Not a valid 3MF file: no 3D/3dmodel.model found inside the archive");

  const xmlText = strFromU8(modelBytes);
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Could not parse 3D/3dmodel.model as XML");

  // Namespace-aware lookup first (the correct way to query an XML doc);
  // falls back to a plain tag-name lookup only if that found nothing, for
  // real-world files that are sloppy about declaring/inheriting the
  // default namespace. Trying both and concatenating unconditionally would
  // double-count every element in the (common) well-formed case, since an
  // unprefixed element's un-namespaced tag name matches both queries.
  const byTag = (parent: Element | Document, tag: string) => {
    const namespaced = [...parent.getElementsByTagNameNS(CORE_NS, tag)];
    return namespaced.length > 0 ? namespaced : [...parent.getElementsByTagName(tag)];
  };

  // Color lookup: propertyGroupId -> [color per index], covering both
  // <basematerials><base displaycolor=".."/></basematerials> and the
  // color-extension <m:colorgroup><m:color color=".."/></m:colorgroup>,
  // which share the same pid/p1..p3 triangle-reference mechanism.
  const colorGroups = new Map<string, Array<[number, number, number] | null>>();
  for (const el of doc.getElementsByTagName("*")) {
    const local = el.localName;
    if (local !== "basematerials" && local !== "colorgroup") continue;
    const id = el.getAttribute("id");
    if (!id) continue;
    const entries: Array<[number, number, number] | null> = [];
    for (const child of Array.from(el.children)) {
      const hex = child.getAttribute("displaycolor") ?? child.getAttribute("color");
      entries.push(parseHexColor(hex));
    }
    colorGroups.set(id, entries);
  }

  // The palette MMU-segmentation codes index into (region N -> this
  // palette's entry N) — picks the largest color group found, since the
  // relevant one needs at least as many entries as the highest painted
  // region index, and a file with exactly one real palette (the normal
  // case) just has one candidate anyway.
  let mmuPalette: Array<[number, number, number] | null> | null = null;
  for (const group of colorGroups.values()) {
    if (!mmuPalette || group.length > mmuPalette.length) mmuPalette = group;
  }

  function colorFor(pid: string | null, pIndex: string | null): [number, number, number] | null {
    if (!pid || pIndex === null) return null;
    const group = colorGroups.get(pid);
    if (!group) return null;
    const i = Number(pIndex);
    return group[i] ?? null;
  }

  const objectsById = new Map<string, Element>();
  for (const obj of byTag(doc, "object")) {
    const id = obj.getAttribute("id");
    if (id) objectsById.set(id, obj);
  }

  const FALLBACK_COLOR: [number, number, number] = [0.7, 0.7, 0.75];
  const positions: number[] = [];
  const colors: number[] = [];

  function emitTriangle(v0: Vec3, v1: Vec3, v2: Vec3, color: [number, number, number]) {
    positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
    for (let k = 0; k < 3; k++) colors.push(color[0], color[1], color[2]);
  }

  function resolveObject(objectId: string, transform: (p: Vec3) => Vec3, inheritedColor: [number, number, number] | null, depth: number) {
    if (depth > 8) return; // guard against malformed cyclic <components>
    const obj = objectsById.get(objectId);
    if (!obj) return;

    const objectPid = obj.getAttribute("pid");
    const objectPIndex = obj.getAttribute("pindex");
    const objectColor = colorFor(objectPid, objectPIndex) ?? inheritedColor;

    const mesh = byTag(obj, "mesh")[0];
    if (mesh) {
      const vertexEls = byTag(byTag(mesh, "vertices")[0] ?? mesh, "vertex");
      const vertices: Vec3[] = vertexEls.map((v) => transform({
        x: Number(v.getAttribute("x")),
        y: Number(v.getAttribute("y")),
        z: Number(v.getAttribute("z")),
      }));

      const triEls = byTag(byTag(mesh, "triangles")[0] ?? mesh, "triangle");
      for (const tri of triEls) {
        const i0 = Number(tri.getAttribute("v1"));
        const i1 = Number(tri.getAttribute("v2"));
        const i2 = Number(tri.getAttribute("v3"));
        const v0 = vertices[i0], v1 = vertices[i1], v2 = vertices[i2];
        if (!v0 || !v1 || !v2) continue;

        const triPid = tri.getAttribute("pid") ?? objectPid;
        const triP1 = tri.getAttribute("p1") ?? objectPIndex;
        const mmuCode = tri.getAttribute("slic3rpe:mmu_segmentation") ?? tri.getAttribute("paint_color");
        const triColor =
          colorFor(triPid, triP1) ?? mmuSegmentationColor(mmuCode, mmuPalette) ?? objectColor ?? FALLBACK_COLOR;
        emitTriangle(v0, v1, v2, triColor);
      }
    }

    const components = byTag(obj, "component");
    for (const comp of components) {
      const refId = comp.getAttribute("objectid");
      if (!refId) continue;
      const childTransform = parseTransform(comp.getAttribute("transform"));
      resolveObject(refId, (p) => transform(childTransform(p)), objectColor, depth + 1);
    }
  }

  const items = byTag(doc, "item");
  if (items.length > 0) {
    for (const item of items) {
      const objectId = item.getAttribute("objectid");
      if (!objectId) continue;
      const transform = parseTransform(item.getAttribute("transform"));
      resolveObject(objectId, transform, null, 0);
    }
  } else {
    // No <build> section (unusual, but tolerate it) — just render every
    // top-level object at the origin.
    for (const id of objectsById.keys()) resolveObject(id, (p) => p, null, 0);
  }

  if (positions.length === 0) throw new Error("3MF file contained no readable triangles");

  return { position: new Float32Array(positions), color: new Float32Array(colors) };
}

/**
 * Builds normals for a non-indexed, flat-shaded geometry the same way the
 * rest of the app expects (STL/PDB import both do this) — since 3MF's
 * core spec doesn't carry per-vertex normals at all, only positions.
 */
export function computeFlatNormals(position: Float32Array): Float32Array {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.computeVertexNormals();
  return geometry.attributes.normal.array as Float32Array;
}

interface MaterialGroup {
  color: [number, number, number];
  /** Triangle indices (into the geometry's index buffer, one per face —
   * i.e. face 0 is index[0..2], face 1 is index[3..5], etc.) using this
   * color. */
  triangleIndices: number[];
}

function quantizeColor(r: number, g: number, b: number): string {
  const q = (v: number) => Math.round(v * 255);
  return `${q(r)},${q(g)},${q(b)}`;
}

/**
 * Exports an INDEXED geometry as a 3MF file, one <basematerials> entry
 * AND one separate <object> per distinct vertex color found (so a
 * subunit-colored or overhang-colored mesh round-trips both its coloring
 * AND its part boundaries into a multi-material 3MF). Requires an indexed
 * geometry — e.g. weldGeometryForExport's output — specifically so
 * triangles that share an edge reference the SAME vertex indices rather
 * than each carrying their own unique-but-coincident copy; a flat
 * (non-indexed) triangle soup, where nothing is ever actually shared, is
 * exactly what produces the "open edges" a slicer's manifold checker
 * flags, even when every position genuinely lines up. Colors are matched
 * per-triangle using its first vertex's color — this app only ever
 * assigns one color per original triangle, so all three of its vertices
 * always agree (a color-boundary edge between two differently-colored
 * regions stays split across two vertex indices post-weld, which is
 * correct: a single vertex can't be two colors at once).
 *
 * Each color group gets its OWN <object>/<mesh>, referenced by its own
 * <build><item>, rather than one merged object with only a per-triangle
 * material hint — a single merged object is what several slicers
 * (PrusaSlicer/OrcaSlicer included) open as one indivisible part, so a
 * multi-chain PDB import couldn't actually be assigned to different
 * filaments/AMS slots per chain even though the color data was present.
 * Splitting into real separate objects makes each part individually
 * selectable in the slicer's own object list.
 */
export function build3MF(geometry: THREE.BufferGeometry): ArrayBuffer {
  const index = geometry.getIndex();
  if (!index) throw new Error("build3MF requires an indexed geometry (see weldGeometryForExport)");
  const position = geometry.attributes.position;
  const colorAttr = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  const triCount = index.count / 3;

  const groups = new Map<string, MaterialGroup>();
  for (let t = 0; t < triCount; t++) {
    const i0 = index.getX(t * 3);
    const r = colorAttr ? colorAttr.getX(i0) : 0.7;
    const g = colorAttr ? colorAttr.getY(i0) : 0.7;
    const b = colorAttr ? colorAttr.getZ(i0) : 0.7;
    const key = quantizeColor(r, g, b);
    let group = groups.get(key);
    if (!group) {
      group = { color: [r, g, b], triangleIndices: [] };
      groups.set(key, group);
    }
    group.triangleIndices.push(t);
  }
  const groupList = [...groups.values()];

  const toHex = (c: number) => Math.round(THREE.MathUtils.clamp(c, 0, 1) * 255).toString(16).padStart(2, "0");
  const materialLines = groupList
    .map((g, i) => `<base name="Part ${i + 1}" displaycolor="#${toHex(g.color[0])}${toHex(g.color[1])}${toHex(g.color[2])}FF"/>`)
    .join("");

  // Object ids start at 2 (id 1 is <basematerials>). Each object carries
  // only the vertices its OWN triangles reference, remapped to a local
  // 0-based index — pulling in the full shared vertex list per object
  // would work too (unused vertices are legal) but bloats every part with
  // geometry from every other part.
  const objectLines: string[] = [];
  const itemLines: string[] = [];
  for (let gi = 0; gi < groupList.length; gi++) {
    const group = groupList[gi];
    const localIndex = new Map<number, number>();
    const vertexLines: string[] = [];
    const triangleLines: string[] = [];
    for (const t of group.triangleIndices) {
      const globalIdx = [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)];
      const local = globalIdx.map((g) => {
        let li = localIndex.get(g);
        if (li === undefined) {
          li = vertexLines.length;
          localIndex.set(g, li);
          vertexLines.push(`<vertex x="${position.getX(g)}" y="${position.getY(g)}" z="${position.getZ(g)}"/>`);
        }
        return li;
      });
      triangleLines.push(`<triangle v1="${local[0]}" v2="${local[1]}" v3="${local[2]}" pid="1" p1="${gi}" p2="${gi}" p3="${gi}"/>`);
    }
    const objectId = gi + 2;
    objectLines.push(
      `<object id="${objectId}" type="model" pid="1" pindex="${gi}">` +
      `<mesh><vertices>${vertexLines.join("")}</vertices><triangles>${triangleLines.join("")}</triangles></mesh>` +
      `</object>`,
    );
    itemLines.push(`<item objectid="${objectId}"/>`);
  }

  const modelXML =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xmlns="${CORE_NS}" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">` +
    `<resources>` +
    `<basematerials id="1">${materialLines}</basematerials>` +
    objectLines.join("") +
    `</resources>` +
    `<build>${itemLines.join("")}</build>` +
    `</model>`;

  const contentTypesXML =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`;

  const relsXML =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;

  const zipped = zipSync({
    "[Content_Types].xml": strToU8(contentTypesXML),
    "_rels/.rels": strToU8(relsXML),
    "3D/3dmodel.model": strToU8(modelXML),
  });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}
