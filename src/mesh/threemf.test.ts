import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { parse3MF, build3MF, computeFlatNormals } from "./threemf";
import { weldGeometryForExport } from "./weld-geometry";

const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";

/** build3MF now requires an indexed geometry (see weld-geometry.ts) — this
 * mirrors exactly what downloadMeshAs3MF does: start from a flat,
 * non-indexed triangle soup (position + per-vertex color, same shape
 * every geometry in this app is in) and weld it before handing it to
 * build3MF, so these tests exercise the real production pipeline rather
 * than a hand-built indexed geometry that could hide a bug in the weld
 * step itself. */
function toIndexedGeometry(position: Float32Array, color: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
  return weldGeometryForExport(geometry);
}

/** Hand-builds a minimal but spec-shaped 3MF: two triangles, two objects,
 * one basematerials group, so parse3MF is exercised against real 3MF
 * structure rather than only against build3MF's own output (round-trip
 * tests alone could hide a bug present in both sides symmetrically). */
function makeSynthetic3MF(): ArrayBuffer {
  const modelXML =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xmlns="${CORE_NS}">` +
    `<resources>` +
    `<basematerials id="1">` +
    `<base name="Red" displaycolor="#FF0000FF"/>` +
    `<base name="Green" displaycolor="#00FF00FF"/>` +
    `</basematerials>` +
    `<object id="10" type="model">` +
    `<mesh>` +
    `<vertices>` +
    `<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>` +
    `</vertices>` +
    `<triangles><triangle v1="0" v2="1" v3="2" pid="1" p1="0"/></triangles>` +
    `</mesh>` +
    `</object>` +
    `<object id="20" type="model">` +
    `<mesh>` +
    `<vertices>` +
    `<vertex x="5" y="0" z="0"/><vertex x="6" y="0" z="0"/><vertex x="5" y="1" z="0"/>` +
    `</vertices>` +
    `<triangles><triangle v1="0" v2="1" v3="2" pid="1" p1="1"/></triangles>` +
    `</mesh>` +
    `</object>` +
    `</resources>` +
    `<build><item objectid="10"/><item objectid="20" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></build>` +
    `</model>`;

  const zipped = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "_rels/.rels": strToU8("<Relationships/>"),
    "3D/3dmodel.model": strToU8(modelXML),
  });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

describe("parse3MF", () => {
  it("reads triangles from multiple objects with per-object material color", () => {
    const parsed = parse3MF(makeSynthetic3MF());
    expect(parsed.position.length).toBe(18); // 2 triangles x 3 verts x 3 floats
    expect(parsed.color.length).toBe(18);
  });

  it("assigns each object's basematerials color correctly", () => {
    const parsed = parse3MF(makeSynthetic3MF());
    // First triangle (object 10) -> "Red" (index 0): [1,0,0].
    expect(parsed.color[0]).toBeCloseTo(1, 2);
    expect(parsed.color[1]).toBeCloseTo(0, 2);
    expect(parsed.color[2]).toBeCloseTo(0, 2);
    // Second triangle (object 20) -> "Green" (index 1): [0,1,0].
    expect(parsed.color[9]).toBeCloseTo(0, 2);
    expect(parsed.color[10]).toBeCloseTo(1, 2);
    expect(parsed.color[11]).toBeCloseTo(0, 2);
  });

  it("applies the <item transform> translation to that object's vertices", () => {
    const parsed = parse3MF(makeSynthetic3MF());
    // Object 20's first vertex was (5,0,0) before translation by (10,0,0).
    expect(parsed.position[9]).toBeCloseTo(15, 5);
    expect(parsed.position[10]).toBeCloseTo(0, 5);
    expect(parsed.position[11]).toBeCloseTo(0, 5);
    // Object 10 had no transform, so its first vertex is untouched.
    expect(parsed.position[0]).toBeCloseTo(0, 5);
  });

  it("throws a clear error for a zip with no 3dmodel.model inside", () => {
    const zipped = zipSync({ "readme.txt": strToU8("not a 3mf") });
    const buf = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
    expect(() => parse3MF(buf as ArrayBuffer)).toThrow();
  });
});

describe("build3MF + parse3MF round-trip", () => {
  it("preserves triangle positions and per-material colors through export and re-import", () => {
    // Two triangles, two distinct colors — mirrors a 2-chain subunit mesh.
    const position = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      10, 0, 0, 11, 0, 0, 10, 1, 0,
    ]);
    const color = new Float32Array([
      1, 0, 0, 1, 0, 0, 1, 0, 0, // triangle 1: red
      0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1, // triangle 2: blue-ish
    ]);

    const buffer = build3MF(toIndexedGeometry(position, color));
    const reparsed = parse3MF(buffer);

    // Triangle count and (for each triangle) position/color must survive,
    // even though welding may reorder/dedupe the underlying vertex list —
    // these two triangles share no edge (they're 10 units apart), so
    // nothing should merge across them.
    expect(reparsed.position.length).toBe(position.length);
    const reparsedTris = [
      reparsed.position.slice(0, 9), reparsed.position.slice(9, 18),
    ];
    const originalTris = [position.slice(0, 9), position.slice(9, 18)];
    for (const orig of originalTris) {
      const match = reparsedTris.some((t) => t.every((v, i) => Math.abs(v - orig[i]) < 1e-4));
      expect(match).toBe(true);
    }
    // Colors round-trip through 8-bit hex, so allow ~1/255 tolerance.
    for (let i = 0; i < color.length; i++) {
      expect(Math.abs(reparsed.color[i] - color[i])).toBeLessThan(0.01);
    }
  });

  it("groups triangles sharing a color into one material rather than one per triangle", () => {
    const position = new Float32Array(18); // two degenerate-but-valid triangles at origin-ish
    position.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]);
    const sameColor = [0.2, 0.6, 0.9];
    const color = new Float32Array([...sameColor, ...sameColor, ...sameColor, ...sameColor, ...sameColor, ...sameColor]);

    const buffer = build3MF(toIndexedGeometry(position, color));
    const reparsed = parse3MF(buffer);
    // Both triangles' first vertex should show the same color, and there
    // should only be one distinct color across all 6 vertices.
    const uniqueColors = new Set<string>();
    for (let v = 0; v < 6; v++) {
      uniqueColors.add(`${reparsed.color[v * 3].toFixed(2)},${reparsed.color[v * 3 + 1].toFixed(2)},${reparsed.color[v * 3 + 2].toFixed(2)}`);
    }
    expect(uniqueColors.size).toBe(1);
  });

  it("actually shares vertex indices across adjacent triangles (not one copy per triangle)", () => {
    // Two triangles sharing an edge: (0,0,0)-(1,0,0) is common to both.
    const position = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 0, 0, 0, 1, 1, 0,
    ]);
    const sameColor = [0.4, 0.4, 0.4];
    const color = new Float32Array([...sameColor, ...sameColor, ...sameColor, ...sameColor, ...sameColor, ...sameColor]);
    const geometry = toIndexedGeometry(position, color);
    // 6 vertex instances in, 2 of them coincide pairwise ((0,0,0) and
    // (1,0,0) each appear in both triangles) -> 4 unique welded vertices.
    expect(geometry.attributes.position.count).toBe(4);

    const buffer = build3MF(geometry);
    const xml = strFromU8(unzipSync(new Uint8Array(buffer))["3D/3dmodel.model"]);
    const vertexCount = (xml.match(/<vertex /g) ?? []).length;
    expect(vertexCount).toBe(4);
  });

  it("throws a clear error when given a non-indexed geometry", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    expect(() => build3MF(geometry)).toThrow();
  });
});

describe("computeFlatNormals", () => {
  it("computes an outward normal for a simple triangle", () => {
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normal = computeFlatNormals(position);
    expect(normal.length).toBe(9);
    // Triangle in the XY plane, CCW winding -> normal should point +Z.
    expect(normal[2]).toBeCloseTo(1, 4);
    expect(normal[0]).toBeCloseTo(0, 4);
    expect(normal[1]).toBeCloseTo(0, 4);
  });
});
