import * as THREE from "three";
import "./style.css";
import { setupScene, frameObject, scaleBuildPlate } from "./viewer/scene-setup";
import { createAxesGizmo, disposeAxesGizmo, scaleAxesGizmo, positionAxesGizmoAtCorner } from "./viewer/axes-gizmo";
import { enableModelDragAndDrop, placeOnBuildPlate, clipPlane, loadSTLFile, buildMeshFromGeometry, COMPARISON_MESH_MATERIAL, MESH_MATERIAL } from "./mesh/load-model";
import { downloadMeshAsSTL } from "./mesh/export-stl";
import { downloadMeshAs3MF } from "./mesh/export-3mf";
import { parse3MF, computeFlatNormals } from "./mesh/threemf";
import {
  applyOverhangColors,
  applySubunitColorsWithOverhangHighlight,
  DEFAULT_CRITICAL_ANGLE_DEG,
  SAFE_COLOR_HEX,
  OVERHANG_COLOR_HEX,
  setOverhangColorMode,
} from "./geometry/overhang-cost";
import { evaluateOrientationCost } from "./geometry/orientation-search";
import type { SupportPathsResult, SupportStyle } from "./geometry/support-paths";
import { buildSupportPathsGroup, disposeSupportPathsGroup } from "./viewer/support-paths-visual";
import { createTextSprite } from "./viewer/text-sprite";
import type { ChainMeshEntry, Atom } from "./geometry/pdb";
import { CHAIN_PALETTES, CHAIN_PALETTE_LABELS, type ChainPaletteId } from "./geometry/chain-palettes";
import type { VoidComponentSummary } from "./geometry/detect-voids";
import type { ComponentHighlightMesh } from "./geometry/detect-voids";
import type {
  OrientationSearchRequest,
  DetectVoidsRequest,
  CloseCavitiesRequest,
  VoxelizePDBRequest,
  GenerateSupportPathsRequest,
  WorkerResponse,
} from "./workers/geometry-worker";
import GeometryWorker from "./workers/geometry-worker?worker";

/** A small "?" button next to a control. Content is meant to actually
 * explain the computation (formula/algorithm), not just restate the
 * label — but showing it inline (the original design) pushed the rest of
 * the accordion section around every time one opened, in an already-
 * narrow panel. Instead each button's HTML is stashed here by key and
 * shown in a persistent side note-box (see #help-panel below and the
 * delegated click listener that reads this map) so opening help never
 * reflows the controls themselves. */
const helpContent = new Map<string, string>();
let helpButtonCount = 0;
function help(html: string): string {
  const key = `h${helpButtonCount++}`;
  helpContent.set(key, html);
  return `<button type="button" class="help-btn" data-help-key="${key}" aria-label="Help">?</button>`;
}

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div id="viewer"></div>
  <div id="drop-overlay">
    <div id="drop-overlay-inner">Drop an .stl, .pdb, .cif, or .3mf file to load it</div>
  </div>
  <div id="controls-panel">
    <button id="cancel-btn" style="display:none">Cancel</button>
    <div class="input-row" id="undo-row">
      <button id="undo-btn" disabled>Undo last change</button>${help(
        `Restores the geometry exactly as it stood before the last Scale, Optimize, or Fill — one step only, not a full history. Subunit colors and the chain legend are restored too, if that operation had changed them.`,
      )}
    </div>
    <div class="void-row">
      <input type="checkbox" id="colorblind-safe-colors" />
      <label for="colorblind-safe-colors">Colorblind-safe colors</label>${help(
        `Applies everywhere color alone carries meaning: the per-chain colors (switched to the Tol Muted palette), the X/Y/Z axis arrows, the needs-support/self-supporting overhang coloring, and the cavity-fill highlight (Okabe–Ito colors).<br><br>
        A chain palette you picked yourself under Scale &amp; view is kept. Colors that came from an imported 3MF file are the file's own and stay as they are — only their overhang flag changes.<br><br>
        Repaints whatever's currently loaded immediately, and applies to anything loaded while it's on.`,
      )}
    </div>

    <details id="section-load" open>
      <summary>1. Load model</summary>
      <div class="field-label"><label for="import-resolution">PDB/mmCIF surface detail:</label>${help(
        `Sets the voxel grid resolution (per axis) the Solvent Excluded Surface is built at for a .pdb/.cif import. Only applies to that pipeline — STL and 3MF import their triangles directly, at whatever resolution the file already has.<br><br>
        <strong>Auto</strong> scales the grid down as atom count grows, so voxelize+marching-cubes stays fast on very large structures (hundreds of thousands of atoms) — a fixed high resolution on those could take minutes. Pick a fixed value instead to keep detail consistent across structures of different sizes, or to force more detail than Auto would choose, accepting the extra import time.`,
      )}</div>
      <select id="import-resolution">
        <option value="auto" selected>Auto (scales with atom count)</option>
        <option value="70">Low (70&sup3;)</option>
        <option value="90">Medium (90&sup3;)</option>
        <option value="110">High (110&sup3;)</option>
        <option value="130">Very high (130&sup3;)</option>
        <option value="180">Extreme (180&sup3;) — slow on large structures</option>
        <option value="240">Maximum (240&sup3;) — slow on large structures</option>
      </select>
      <input type="file" id="file-input" accept=".stl,.pdb,.3mf,.cif" style="display:none" />
      <button id="browse-btn">Browse for a file…</button>
      <div class="field-label"><label for="fetch-id-input">Fetch from RCSB by ID:</label>${help(
        `Downloads directly from <span class="formula" style="display:inline;padding:1px 4px;">files.rcsb.org/download/{ID}.{format}</span> — the same file you'd get visiting the URL yourself, no API key needed.<br><br>
        <strong>Nothing is saved to disk by this.</strong> The file is fetched straight into memory and read from there — not written to your Downloads folder or anywhere else. It exists only for as long as this session stays open; reload or close it and it's gone (the structure itself, not your computer's storage — nothing was ever written). The only things this app writes to disk are what you explicitly save via the Export buttons in section 5.<br><br>
        <strong>mmCIF</strong> is the modern archive format: no per-column width limit, so it can represent structures with tens of thousands of atoms or hundreds of chains that fixed-column PDB simply can't fit. RCSB now calls PDB format legacy.<br><br>
        <strong>PDB (legacy)</strong> is the old fixed-column text format (columns 31-38/39-46/47-54 = x/y/z, column 22 = chain). Still fine for small-to-medium structures; large ones may be truncated or unavailable in it at all.`,
      )}</div>
      <div class="input-row">
        <input type="text" id="fetch-id-input" placeholder="e.g. 6LU7" maxlength="8" style="width:90px" />
        <select id="fetch-format-select">
          <option value="cif" selected>mmCIF</option>
          <option value="pdb">PDB (legacy)</option>
        </select>
      </div>
      <div class="field-label"><label for="fetch-content-select">Structure content:</label>${help(
        `<strong>Biological assembly</strong> is the biologically real molecule — the form RCSB's own structure page shows you by default, and usually what you actually want to print. Many entries are <em>deposited</em> as just one copy of a repeating unit even though the functional protein is a dimer, trimer, or larger: RCSB stores the symmetry operations that rebuild the full complex, and this option downloads the already-rebuilt file (<span class="formula" style="display:inline;padding:1px 4px;">{ID}-assembly1.cif</span>, or <span class="formula" style="display:inline;padding:1px 4px;">{ID}.pdb1</span> in legacy format). Symmetry copies of a chain arrive suffixed — A, A-2, A-3 — so each still gets its own subunit color.<br><br>
        <strong>Asymmetric unit</strong> is the raw deposited coordinate file (<span class="formula" style="display:inline;padding:1px 4px;">{ID}.cif</span>) — the crystallographic repeating unit, with no symmetry expansion applied. Pick this if you specifically want what was deposited rather than the assembled complex, or if an entry has no assembly defined.<br><br>
        If a structure looked "smaller" or was missing subunits compared to the RCSB web page, this is why — that page shows Assembly 1 while a plain download gives the asymmetric unit.`,
      )}</div>
      <select id="fetch-content-select">
        <option value="assembly1" selected>Biological assembly (as shown on RCSB)</option>
        <option value="asym">Asymmetric unit (deposited file)</option>
      </select>
      <button id="fetch-id-btn">Fetch</button>
      <div id="chain-filter-row" style="display:none">
        <div class="field-label"><label for="chain-filter">Build surface from:</label>${help(
          `Rebuilds the molecular surface from a single chain (subunit) of whatever structure is loaded, instead of all of them — useful for printing one protomer of a large complex, or checking a single subunit's own printability.<br><br>
          Rebuilding reuses the atom records already parsed from the loaded file, so it never re-downloads anything and works the same for a fetched structure or a local .pdb/.cif you opened yourself. Switch back to "All chains" and apply again to restore the full structure. Note this discards any Fill/Optimize work on the current mesh, since it rebuilds the surface from scratch.`,
        )}</div>
        <div class="input-row">
          <select id="chain-filter"></select>
          <button id="apply-chain-filter-btn">Apply</button>
        </div>
      </div>
      <div id="hetero-filter-row" style="display:none">
        <div class="field-label">Ligands &amp; ions found:</div>${help(
          `Every distinct <strong>heteroatom</strong> (ligand, metal ion, or leftover crystallization molecule — buffer salts, cryoprotectants like glycerol or PEG) the loaded file actually contains, all checked in by default. Water is never listed here — it's always excluded, because each crystallographic water molecule would otherwise become its own separate speck in the print.<br><br>
          Uncheck anything you don't want in the printed surface, then Apply to rebuild — reusing the atom records already parsed, so it never re-downloads anything, the same as the chain filter above (and composes with it: rebuilding respects whichever chain is currently selected too).<br><br>
          A ligand genuinely bound in a real pocket usually overlaps the structure's own surface and prints fine either way — this mainly matters for a loose ion or crystallization additive sitting apart from the structure, which becomes its own tiny disconnected fragment once voxelized (a slicer then adds pointless support material trying to hold it up). If a print comes out with small floating pieces, this list is where to find and exclude the culprit.`,
        )}
        <div id="hetero-filter-list"></div>
        <button id="apply-hetero-filter-btn">Apply</button>
      </div>
    </details>

    <details id="section-view">
      <summary>2. Scale &amp; view</summary>
      <div id="scale-current-size"></div>
      <div class="field-label"><label for="scale-mode">Scale model:</label>${help(
        `Scaling is always <strong>uniform</strong> — the same factor applies to X, Y, and Z at once, so proportions never distort.<br>
        <span class="formula">geometry.scale(f, f, f)</span>
        <strong>By percentage:</strong> f = pct ÷ 100.<br>
        <strong>To target size:</strong> f = target ÷ (current size along the chosen axis).`,
      )}</div>
      <select id="scale-mode">
        <option value="percent">By percentage</option>
        <option value="absolute">To target size (mm)</option>
      </select>
      <div id="scale-percent-row" class="input-row">
        <input type="number" id="scale-percent" min="0.01" step="0.01" value="100.00" />
        <span>%</span>
      </div>
      <div id="scale-absolute-row" class="input-row" style="display:none">
        <select id="scale-axis">
          <option value="largest" selected>Largest dim</option>
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
        <input type="number" id="scale-target" min="0.01" step="0.01" placeholder="target mm" />
      </div>
      <button id="apply-scale-btn" disabled>Apply scale</button>
      <div class="slider-label"><label for="cross-section">Cross-section: <span id="cross-section-value">off</span></label>${help(
        `Sweeps a clipping plane along the model's own X axis to reveal what's inside — purely a view setting, the underlying geometry is never touched. 0% shows the whole model, 100% clips it all away.<br><br>
        Double-click the slider, or the Reset button beside it, to snap back to 0% (off).`,
      )}</div>
      <div class="input-row">
        <input type="range" id="cross-section" min="0" max="100" step="1" value="0" />
        <button type="button" id="cross-section-reset" title="Reset cross-section to off">Reset</button>
      </div>
      <div class="void-row">
        <input type="checkbox" id="show-subunit-colors" disabled />
        <label for="show-subunit-colors">Show subunit colors</label>${help(
          `For a multi-chain PDB/mmCIF import, each chain is voxelized and remeshed <em>independently</em> — not just recolored after the fact — so chain boundaries are geometrically exact, not an approximate nearest-atom guess at a shared surface.<br><br>
          Overhang need still shows in this view: any face past the critical angle gets flagged the same solid red the plain overhang view uses, rather than support-relevant faces disappearing just because you're looking at chain identity instead. Filling a cavity colors its new interior patch to match whichever chain's surface is nearest, so a sealed pocket reads as part of its own chain rather than an unexplained extra part.`,
        )}
      </div>
      <div class="input-row">
        <label for="chain-palette-select" style="white-space:nowrap">Palette:</label>${help(
          `Which set of colors chains cycle through. Switching is instant — it just recolors, no rebuild — and carries over correctly even after Fill adds a sealed cavity patch to a chain.<br><br>
          <strong>Okabe&ndash;Ito</strong> and <strong>Tol Muted</strong> are standard colorblind-safe qualitative palettes, designed to stay distinguishable under the common forms of color vision deficiency. <strong>Viridis</strong> is technically meant for ordered/continuous data rather than discrete categories like chains, but it's colorblind-safe too (and still readable in grayscale) so it's offered as an option regardless.<br><br>
          Every palette caps out at a limited number of distinct colors (7&ndash;12 depending which) — a structure with more chains than that cycles back to repeating colors, same as the default palette already did.`,
        )}
        <select id="chain-palette-select" disabled>
          ${Object.entries(CHAIN_PALETTE_LABELS)
            .map(([id, label]) => `<option value="${id}"${id === "default" ? " selected" : ""}>${label}</option>`)
            .join("")}
        </select>
      </div>
      <div id="chain-legend"></div>
      <div id="stats-panel"></div>
    </details>

    <details id="section-cavities">
      <summary>3. Voids &amp; cavities</summary>
      <div class="field-label"><label for="cavity-resolution">Void detection resolution:</label>${help(
        `Sets the voxel grid's resolution along the model's longest axis for detection — shared by both Cavities and Tunnels below, since they come from one flood-fill pass over the same grid. Higher finds smaller/thinner voids (including narrow pockets right at a subunit interface) and shapes their seal more precisely.<br><br>
        Since Fill only adds sealing patches <em>inside</em> existing voids and never re-voxelizes the exterior, this has much lower stakes — it no longer affects the visible surface at all, only which tiny voids get found and how smooth their (invisible, interior) seal looks.`,
      )}</div>
      <select id="cavity-resolution">
        <option value="32">Low (32&sup3;)</option>
        <option value="64" selected>Medium (64&sup3;)</option>
        <option value="128">High (128&sup3;)</option>
        <option value="192">Very high (192&sup3;)</option>
        <option value="256">Extreme (256&sup3;)</option>
        <option value="320">Maximum (320&sup3;) — slow</option>
      </select>
      <div class="void-group">
        <div class="void-group-title">Cavities <span class="void-group-sub">— fully enclosed, incl. buried subunit-interface pockets</span></div>
        <div class="void-row">
          <input type="checkbox" id="cavity-threshold-custom" />
          <label for="cavity-threshold-custom">Custom auto-select size limit (default: select all cavities)</label>${help(
            `By default every detected cavity starts pre-checked for filling. Turning this on instead pre-checks only cavities at or under the chosen voxel count. Either way, you can still hand-tune individual checkboxes in the list afterward.`,
          )}
        </div>
        <div class="input-row" id="cavity-threshold-row" style="display:none">
          <input type="range" id="cavity-threshold-slider" min="1" max="10000" step="1" value="1000" />
          <span id="cavity-threshold-value">≤ 1,000 voxels</span>
        </div>
        <button id="detect-cavities-btn" disabled>Find cavities</button>${help(
          `Voxelizes the surface, then flood-fills 6-connected empty space starting from a guaranteed-exterior corner voxel. A <strong>cavity</strong> is empty voxels the flood-fill never reaches — fully enclosed, including a pocket trapped between two touching subunits with no path out (a real print concern: any support material generated inside one is stuck there permanently once printed).<br><br>
          Find cavities and Find tunnels each run their own scan and only update their own list — finding tunnels never resets your cavity selection, and vice versa.`,
        )}
        <div class="void-row">
          <input type="checkbox" id="show-void-highlights" checked />
          <label for="show-void-highlights">Highlight on model (magenta = will fill, orange = excluded)</label>${help(
            `Builds a small standalone mesh for each of the 20 largest cavities and 20 largest tunnels — literally remeshing just that void's own enclosed voxels via marching cubes — colored magenta (will fill) or orange (excluded).<br><br>
            Since voids are enclosed inside solid material, the outer shell is also made semi-transparent and highlights are drawn with depth-testing disabled, so they stay visible through it rather than being hidden behind the near wall.`,
          )}
        </div>
        <div id="cavities-list"></div>
        <button id="apply-fill-cavities-btn" disabled>Fill selected cavities</button>${help(
          `Adds a small sealing mesh for each selected cavity directly onto the existing exterior geometry. The exterior is <strong>never</strong> re-voxelized or touched — concatenating the two is already a valid union, no boolean/CSG merge needed, and the visible surface stays byte-identical.<br><br>
          Unlike the on-model highlight (which shows the void's <em>full</em> detected extent), the seal is pulled back from the void's edge by a safety margin: right at a thin wall, the detection grid's idea of where the outside begins can be off by about a voxel, and a seal built exactly to that boundary could poke through the real surface.<br><br>
          How much margin depends on where the cavity sits. One buried at least 2 voxels from the outside is sealed to its full extent — a seal there can't reach the surface. One that may lie close to the outside gets the largest margin that still leaves something to seal (1 voxel, then ¾, ½, ¼, and finally none). In practice every selected cavity gets sealed.`,
        )}
      </div>
      <div class="void-group">
        <div class="void-group-title">Tunnels <span class="void-group-sub">— open channels, but may still be worth sealing</span></div>
        <button id="detect-tunnels-btn" disabled>Find tunnels</button>${help(
          `A <strong>tunnel</strong> is empty voxels the flood-fill <em>does</em> reach, but that still sit within the model's own bounds (not the padding margin) — an open channel through the part, most often along the seam where two subunits meet without ever fully closing off.<br><br>
          A tunnel's boundary borders genuinely exterior space at its opening, so its seal always keeps the full 1-voxel margin — that pulls the seal back from the opening instead of closing it over. What's different from a cavity is also intent: filling a tunnel removes an open channel entirely, a bigger geometric change than sealing a buried pocket, which is why none are pre-selected.<br><br>
          Find tunnels only updates the tunnel list — your cavity list and its selection stay as they are.`,
        )}
        <div id="tunnels-list"></div>
        <button id="apply-fill-tunnels-btn" disabled>Fill selected tunnels</button>${help(
          `Builds seals the same way as Fill selected cavities, with the exterior left byte-identical — except that a tunnel always keeps the full 1-voxel margin, never less. A tunnel thinner than about 3 detection voxels has nothing left after that margin and is skipped; raise the detection resolution and find tunnels again to seal it. Nothing is pre-selected; check the ones you want sealed first.`,
        )}
      </div>
    </details>

    <details id="section-optimize">
      <summary>4. Optimize orientation</summary>
      <div class="slider-label"><label for="critical-angle">Critical overhang angle: <span id="critical-angle-value"></span>&deg;</label>${help(
        `A face is flagged as needing support once it leans more than this many degrees past vertical, measured from its normal's Z component:<br>
        <span class="formula">lean° = asin(clamp(&minus;normalZ, &minus;1, 1)) &times; 180/&pi;</span>
        0&deg; = a vertical wall (self-supporting). 90&deg; = a flat, downward-facing overhang (worst case).<br><br>
        This is the single parameter everything in this section is measured against: it defines the cost formula Optimize minimizes, which faces the organic support paths grow from, and the maximum lean those support branches themselves may have. It also drives the red/blue overhang coloring in the viewport — so changing it does repaint the model, even though it never alters the geometry.<br><br>
        Set it to match your printer and material: most FDM machines manage about 45&deg;, resin printers often more.`,
      )}</div>
      <input type="range" id="critical-angle" min="0" max="90" step="1" value="${DEFAULT_CRITICAL_ANGLE_DEG}" />
      <div id="overhang-legend" class="void-row-readonly"></div>
      <div id="proxy-advisory" class="void-row-readonly" style="display:none">This model is complex — Optimize may take a while. The proxy below can speed it up (searches a coarse stand-in, then applies the result losslessly to the full model).</div>
      <div class="void-row">
        <input type="checkbox" id="use-proxy" />
        <label for="use-proxy">Use low-res proxy for orientation search</label>${help(
          `Orientation search costs O(triangles&sup2;) per candidate direction — infeasible directly on a dense import (a 200k-triangle mesh would mean roughly 40 billion operations per candidate, times ~38 candidates evaluated).<br><br>
          This voxelizes the mesh at the chosen coarse resolution and searches a marching-cubes remesh of <em>that</em> instead. The winning result is just a rotation (a quaternion), so it's exact and lossless to apply to the full-resolution mesh afterward — only the search itself is approximate, never the final geometry.`,
        )}
      </div>
      <select id="proxy-resolution">
        <option value="24">Coarse proxy (24&sup3;)</option>
        <option value="32" selected>Medium proxy (32&sup3;)</option>
        <option value="48">Fine proxy (48&sup3;)</option>
      </select>
      <button id="optimize-btn" disabled>Optimize orientation</button>${help(
        `Samples ~32 points on a Fibonacci sphere plus the 6 axis-aligned directions (mechanical/molecular parts often have their true optimum exactly on one — sphere sampling alone can miss a narrow basin), scores each, refines a small grid around the best few, and picks the winner. The sphere sample is randomly rotated on every run, so the result doesn't depend on how the structure happens to be oriented in its file; the 6 axis directions stay fixed.<br>
        <span class="formula">cost = &Sigma; over overhang triangles of
area &times; (drop height to the plate,
or to whatever surface occludes it first)</span>
        Score also subtracts a build-plate contact-area term (stability weight &asymp; 15% of the model's bounding radius) — otherwise a corner-balanced orientation can tie a flat, stable rest, since both can show zero triangles over the critical angle.<br><br>
        Safe to drag-rotate the model to inspect it while this runs — the search works from a snapshot of the geometry taken the instant you click, so spinning the view afterward has no effect on the result. Drag-rotating is always view-only, in fact: it changes how the model looks on screen, never the geometry itself, so it has no effect on exports either — see Export's help below.`,
      )}
      <div class="void-row">
        <input type="checkbox" id="show-support-paths" />
        <label for="show-support-paths">Show support paths</label>${help(
          `Illustrative only — not a real slicer simulation, and never affects what gets exported. All three styles start from the same overhang triangles, bucketed into a grid and area-weighted into "roots", each raycast straight down to find where it lands (the plate, or another surface that occludes it first — bridging).<br><br>
          <strong>Organic</strong> — roots landing on the plate are greedily merged pairwise by proximity as they descend, approximating how tree supports fuse into fewer trunks near the bed. Each merge's own connecting segments are kept within the critical overhang angle (above) of vertical — same limit as the model's own faces, since a support branch is printed the same way the part is. A pair that would need a shallower, unprintable connector to merge is left unmerged that round (tried again against other tips, or routed straight to the plate independently) rather than drawing a segment that couldn't actually be printed as-is.<br><br>
          <strong>Snug</strong> — the same roots as Organic (tightly following the real overhang shape), each drawn as its own independent straight vertical column instead of merging into branches.<br><br>
          <strong>Grid</strong> — roots snapped to a regular lattice instead of the overhang's own shape, each its own straight vertical column — a blockier, more generic pattern.<br><br>
          Runs in the background, so it won't freeze the interface even on a large model — skipped only above 3,000,000 triangles.`,
        )}
      </div>
      <div class="input-row">
        <label for="support-style-select" style="white-space:nowrap">Style:</label>
        <select id="support-style-select">
          <option value="organic" selected>Organic (tree-like)</option>
          <option value="snug">Snug (straight, follows shape)</option>
          <option value="grid">Grid (straight, regular lattice)</option>
        </select>
      </div>
      <div class="void-row">
        <input type="checkbox" id="show-comparison" />
        <label for="show-comparison">Compare to start model (side-by-side)</label>${help(
          `Places a copy of the structure <em>as it was when you loaded it</em> beside the current model, offset by a gap proportional to the model's own width.<br><br>
          The baseline is always the original loaded file — so the "Start" copy shows the cumulative effect of <strong>everything</strong> you've done since, not just the orientation search: scaling, cavity/tunnel filling, and optimization all show up in the difference.<br><br>
          Undo does not move this baseline; only loading a new structure resets it.`,
        )}
      </div>
    </details>

    <details id="section-export">
      <summary>5. Export</summary>
      <div class="void-row-readonly">Exports always reflect the model's actual geometry — the orientation from Optimize (or wherever you last left it), never whatever angle you've dragged the model to just for looking at it. Drag-rotating the model in the viewport is view-only and has no effect on what gets saved.</div>
      <div class="field-label"><label for="base-height">Raise base to Z (mm) — for breakaway support/interface layers</label>${help(
        `Offsets the <em>exported copy's</em> Z so its lowest point sits at this height instead of 0 — the live model you're editing on screen is never touched (Optimize/Fill both depend on it always resting at Z=0).<br><br>
        Meant for a breakaway support/interface layer you'll print as a separate raft below. Note: many slicers auto-drop imported objects back onto the bed regardless of the file's own coordinates — check your slicer's placement behavior if the offset doesn't seem to stick.`,
      )}</div>
      <div class="input-row">
        <input type="number" id="base-height" min="0" step="0.01" value="0.00" />
        <button id="preview-raise-btn">Preview</button>
      </div>
      <button id="export-btn" disabled>Export STL</button>${help(
        `Saves the current model as a standard STL file, ready to open in any slicer.<br><br>
        In the desktop app, this opens a native Save As dialog so you can pick exactly where it goes. In the browser version, it uses your browser's own ordinary file-download mechanism instead — the file lands wherever your browser normally puts downloads (usually a "Downloads" folder), the same as downloading anything else from a website, since a browser tab has no way to choose a location itself.<br><br>
        Before writing the file, neighboring triangles are <strong>welded</strong> together — joined so they genuinely share their common corner points. Without this, slicers can report the model as having "open edges" or being "not watertight" even though it is completely closed, because internally each triangle carries its own separate copy of every corner and nothing is technically connected to anything else. Welding is what makes a slicer see one sealed solid.<br><br>
        This happens only in the saved copy; the model on screen is untouched.`,
      )}
      <button id="export-3mf-btn" disabled>Export 3MF (multi-material)</button>${help(
        `Same position-welding as STL export, but 3MF also carries color: triangles are grouped into separate materials — <strong>and</strong> separate objects, one per color group, each with its own <code>&lt;item&gt;</code> placement. A slicer's object list shows each part individually (selectable, assignable to its own filament/AMS slot), not one merged model with only a material hint.<br><br>
        Grouping always follows <strong>chains</strong>, whichever view is currently on screen: with subunit colors showing, that's one object per chain, exactly matching what you'd expect from "N subunits in, N parts out" — the red overhang highlight visible on screen in that view is left out of the exported file on purpose, so it can't split a single chain into extra, meaningless sub-parts. With overhang colors showing instead, export groups by that (typically 2 objects: needs-support / self-supporting).`,
      )}
    </details>

    <details id="section-log">
      <summary>Session log</summary>
      <div id="session-log"></div>
    </details>
  </div>
  <div id="version-badge">v: ${__APP_VERSION__}</div>
  <div id="help-panel">
    <div id="help-panel-header">
      <span>Help</span>
      <button type="button" id="help-panel-close" aria-label="Close">&times;</button>
    </div>
    <div id="help-panel-content"></div>
  </div>
  <div id="status"></div>
`;

const controlsPanelEl = document.querySelector<HTMLDivElement>("#controls-panel")!;
const viewerEl = document.querySelector<HTMLDivElement>("#viewer")!;
const overlayEl = document.querySelector<HTMLDivElement>("#drop-overlay")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const angleSliderEl = document.querySelector<HTMLInputElement>("#critical-angle")!;
const angleValueEl = document.querySelector<HTMLSpanElement>("#critical-angle-value")!;
const overhangLegendEl = document.querySelector<HTMLDivElement>("#overhang-legend")!;
const clipSliderEl = document.querySelector<HTMLInputElement>("#cross-section")!;
const clipValueEl = document.querySelector<HTMLSpanElement>("#cross-section-value")!;
const clipResetBtnEl = document.querySelector<HTMLButtonElement>("#cross-section-reset")!;
const optimizeBtnEl = document.querySelector<HTMLButtonElement>("#optimize-btn")!;
const exportBtnEl = document.querySelector<HTMLButtonElement>("#export-btn")!;
const cavityResolutionEl = document.querySelector<HTMLSelectElement>("#cavity-resolution")!;
const cavityThresholdCustomEl = document.querySelector<HTMLInputElement>("#cavity-threshold-custom")!;
const cavityThresholdRowEl = document.querySelector<HTMLDivElement>("#cavity-threshold-row")!;
const cavityThresholdSliderEl = document.querySelector<HTMLInputElement>("#cavity-threshold-slider")!;
const cavityThresholdValueEl = document.querySelector<HTMLSpanElement>("#cavity-threshold-value")!;
const detectCavitiesBtnEl = document.querySelector<HTMLButtonElement>("#detect-cavities-btn")!;
const detectTunnelsBtnEl = document.querySelector<HTMLButtonElement>("#detect-tunnels-btn")!;
const cavitiesListEl = document.querySelector<HTMLDivElement>("#cavities-list")!;
const tunnelsListEl = document.querySelector<HTMLDivElement>("#tunnels-list")!;
const applyFillCavitiesBtnEl = document.querySelector<HTMLButtonElement>("#apply-fill-cavities-btn")!;
const applyFillTunnelsBtnEl = document.querySelector<HTMLButtonElement>("#apply-fill-tunnels-btn")!;
const baseHeightEl = document.querySelector<HTMLInputElement>("#base-height")!;
const previewRaiseBtnEl = document.querySelector<HTMLButtonElement>("#preview-raise-btn")!;
const useProxyEl = document.querySelector<HTMLInputElement>("#use-proxy")!;
const proxyAdvisoryEl = document.querySelector<HTMLDivElement>("#proxy-advisory")!;
const showVoidHighlightsEl = document.querySelector<HTMLInputElement>("#show-void-highlights")!;
const proxyResolutionEl = document.querySelector<HTMLSelectElement>("#proxy-resolution")!;
const showSupportPathsEl = document.querySelector<HTMLInputElement>("#show-support-paths")!;
const supportStyleSelectEl = document.querySelector<HTMLSelectElement>("#support-style-select")!;
const showComparisonEl = document.querySelector<HTMLInputElement>("#show-comparison")!;
const statsPanelEl = document.querySelector<HTMLDivElement>("#stats-panel")!;
const scaleCurrentSizeEl = document.querySelector<HTMLDivElement>("#scale-current-size")!;
const scaleModeEl = document.querySelector<HTMLSelectElement>("#scale-mode")!;
const scalePercentRowEl = document.querySelector<HTMLDivElement>("#scale-percent-row")!;
const scalePercentEl = document.querySelector<HTMLInputElement>("#scale-percent")!;
const scaleAbsoluteRowEl = document.querySelector<HTMLDivElement>("#scale-absolute-row")!;
const scaleAxisEl = document.querySelector<HTMLSelectElement>("#scale-axis")!;
const scaleTargetEl = document.querySelector<HTMLInputElement>("#scale-target")!;
const applyScaleBtnEl = document.querySelector<HTMLButtonElement>("#apply-scale-btn")!;
const undoBtnEl = document.querySelector<HTMLButtonElement>("#undo-btn")!;
const colorblindSafeColorsEl = document.querySelector<HTMLInputElement>("#colorblind-safe-colors")!;
const cancelBtnEl = document.querySelector<HTMLButtonElement>("#cancel-btn")!;
const fileInputEl = document.querySelector<HTMLInputElement>("#file-input")!;
const browseBtnEl = document.querySelector<HTMLButtonElement>("#browse-btn")!;
const importResolutionEl = document.querySelector<HTMLSelectElement>("#import-resolution")!;
const fetchContentSelectEl = document.querySelector<HTMLSelectElement>("#fetch-content-select")!;
const chainFilterRowEl = document.querySelector<HTMLDivElement>("#chain-filter-row")!;
const chainFilterEl = document.querySelector<HTMLSelectElement>("#chain-filter")!;
const applyChainFilterBtnEl = document.querySelector<HTMLButtonElement>("#apply-chain-filter-btn")!;
const heteroFilterRowEl = document.querySelector<HTMLDivElement>("#hetero-filter-row")!;
const heteroFilterListEl = document.querySelector<HTMLDivElement>("#hetero-filter-list")!;
const applyHeteroFilterBtnEl = document.querySelector<HTMLButtonElement>("#apply-hetero-filter-btn")!;
const fetchIdInputEl = document.querySelector<HTMLInputElement>("#fetch-id-input")!;
const fetchFormatSelectEl = document.querySelector<HTMLSelectElement>("#fetch-format-select")!;
const fetchIdBtnEl = document.querySelector<HTMLButtonElement>("#fetch-id-btn")!;
const sessionLogEl = document.querySelector<HTMLDivElement>("#session-log")!;
const showSubunitColorsEl = document.querySelector<HTMLInputElement>("#show-subunit-colors")!;
const chainPaletteSelectEl = document.querySelector<HTMLSelectElement>("#chain-palette-select")!;
const chainLegendEl = document.querySelector<HTMLDivElement>("#chain-legend")!;
const export3mfBtnEl = document.querySelector<HTMLButtonElement>("#export-3mf-btn")!;

const sceneSetup = setupScene(viewerEl);
const { scene, camera, controls, buildPlate } = sceneSetup;
// `let`, not `const`: the "Colorblind-safe colors" toggle rebuilds this
// with a different color triad (a label's color is baked into its own
// canvas texture at creation time — see createAxesGizmo — so there's no
// material property to flip on the existing one).
let axesGizmo = sceneSetup.axesGizmo;

let currentMesh: THREE.Mesh | null = null;
let currentBaseName = "model";

// Atom records from the most recent .pdb/.cif load, kept so the chain
// subset control can rebuild the surface from a single chain without
// re-reading the file (or re-downloading a fetched structure).
let loadedAtoms: Atom[] | null = null;
let loadedAtomsBaseName = "model";
let loadedAtomsSourceLabel = "";
let criticalAngleDeg = DEFAULT_CRITICAL_ANGLE_DEG;
let worker: Worker | null = null;

// Void detection is a separate, cheap step from applying a fill — the
// lists below let the user pick which cavities/tunnels to fill before any
// marching-cubes remeshing happens. Resolution is pinned at detection
// time so a later dropdown change can't desync the ids from the grid
// they were detected against (detection is deterministic, so re-running
// it at apply time with the SAME resolution reproduces the same ids).
// Cavities and tunnels come from ONE shared flood-fill pass (see
// detect-voids.ts), so a "Find" click always computes both — but each
// kind keeps its own independent record (components/resolution/voxel
// size) below, and a click only ever overwrites its OWN kind's record.
// Otherwise clicking "Find tunnels" would silently refresh/reset the
// cavities list (and its selection/Fill button) out from under a user
// who never touched cavities that time around — surprising, and not what
// either list's own name promised.
interface VoidDetectionRecord {
  components: VoidComponentSummary[];
  resolution: number;
  voxelSize: number;
}
const EMPTY_DETECTION: VoidDetectionRecord = { components: [], resolution: 0, voxelSize: 0 };
let cavityDetection: VoidDetectionRecord = EMPTY_DETECTION;
let tunnelDetection: VoidDetectionRecord = EMPTY_DETECTION;
function detectionFor(kind: "cavity" | "tunnel"): VoidDetectionRecord {
  return kind === "cavity" ? cavityDetection : tunnelDetection;
}
const selectedCavityIds = new Set<number>();
// Never auto-populated (unlike cavities) — filling a tunnel removes an
// open channel entirely, a bigger geometric change worth a deliberate
// per-item choice rather than an "all included by default" convenience.
const selectedTunnelIds = new Set<number>();

// One small standalone mesh per detected cavity (its own remeshed
// surface, not just a voxel count) — a child of currentMesh so it rides
// along with any rotation, colored green/gray by whether it's currently
// selected to fill. Cavities are fully enclosed, so seeing them at all
// needs the shell rendered semi-transparent (toggled alongside these).
// Keeps each entry's own kind alongside the mesh so a scoped clear (one
// kind redetected, see clearCavityHighlights) can tell which highlights
// are its own without consulting mutable detection state that, by then,
// may already have moved on to the next result.
const cavityHighlightMeshes = new Map<number, { mesh: THREE.Mesh; kind: "cavity" | "tunnel" }>();
// Deliberately synthetic/saturated colors, chosen to not be confusable
// with either the overhang red/blue scheme or the muted qualitative
// subunit palette — a cavity highlight needs to read as "UI overlay", not
// blend in as if it were part of the structure's own coloring. `let`, not
// `const`: the "Colorblind-safe colors" toggle below reassigns both.
let CAVITY_INCLUDE_COLOR = 0xff1493;
let CAVITY_EXCLUDE_COLOR = 0xffa500;
const DEFAULT_CAVITY_INCLUDE_COLOR = 0xff1493;
const DEFAULT_CAVITY_EXCLUDE_COLOR = 0xffa500;
// Okabe-Ito bluish-green/orange — same colorblind-safe family used
// elsewhere in the app whenever the toggle is on.
const COLORBLIND_CAVITY_INCLUDE_COLOR = 0x009e73;
const COLORBLIND_CAVITY_EXCLUDE_COLOR = 0xe69f00;
const HIGHLIGHT_SHELL_OPACITY = 0.25;

// evaluateOrientationCost is O(triangles²) — past this, a single
// evaluation (not just the full search) stops being practical. Used to
// auto-suggest the orientation-search proxy on load, and to skip cost
// display (rather than hang the tab) for fill's before/after numbers.
const DIRECT_COST_EVAL_TRIANGLE_LIMIT = 20000;

// The as-loaded geometry, kept untouched for the "start model" side of
// the comparison view — captured once per load, independent of whatever
// Optimize/Fill do to currentMesh afterward.
let originalGeometry: THREE.BufferGeometry | null = null;
let comparisonMesh: THREE.Mesh | null = null;
let supportPathsGroup: THREE.Group | null = null;
let comparisonSupportPathsGroup: THREE.Group | null = null;
let comparisonLabel: THREE.Sprite | null = null;
let currentLabel: THREE.Sprite | null = null;

// Per-vertex "subunit" coloring (one solid color per PDB chain, or
// whatever a 3MF file's own materials specify) — independent of the
// overhang red/blue coloring, which recolorCurrentMesh() always used to
// apply unconditionally. Kept alongside (not merged into) the geometry's
// live "color" attribute so toggling the view doesn't need to recompute
// anything or lose the other coloring. Cleared whenever the geometry gets
// rebuilt without part identity surviving (Fill remeshes from a plain
// voxel grid with no per-chain tracking).
let subunitColor: Float32Array | null = null;
let chainLegend: ChainMeshEntry[] | null = null;
/** Parallel to subunitColor, but one entry per VERTEX (not per float
 * triple): which palette index that vertex's chain maps to. Recoloring
 * from this instead of just overwriting subunitColor directly is what
 * lets the palette switch below be instant (a pure client-side recolor,
 * no re-voxelize/remesh) and still correct after Fill adds a sealed
 * cavity patch — see runFill, which extends this array with the sealed
 * patch's own nearest-chain index rather than a frozen RGB snapshot that
 * a later palette switch couldn't update. Null whenever subunitColor
 * doesn't come from real chain identity in the first place (a 3MF
 * import's colors are whatever that file's own materials specified). */
let subunitChainIndex: Int32Array | null = null;
let chainPaletteId: ChainPaletteId = "default";
// Tol Muted rather than Okabe–Ito: Okabe–Ito's vermillion is also the
// colorblind overhang flag, so a 6th chain would be indistinguishable from it.
const COLORBLIND_CHAIN_PALETTE: ChainPaletteId = "tol-muted";

// Single-level undo: the geometry as it stood immediately before the last
// Scale/Optimize/Fill, so a bad result doesn't force re-dropping the
// original file. Deliberately not a full history stack — one step back
// covers the "oops" case without holding onto an unbounded chain of full
// geometry clones for a possibly-huge protein mesh.
interface UndoPoint {
  geometry: THREE.BufferGeometry;
  label: string;
  subunitColor: Float32Array | null;
  chainLegend: ChainMeshEntry[] | null;
  subunitChainIndex: Int32Array | null;
}
let undoPoint: UndoPoint | null = null;

function setStatus(text: string, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

/** Durable, append-only record of what happened this session — unlike
 * `setStatus`, which the next operation immediately overwrites, so there's
 * never a single place to see e.g. both the fill AND the optimize deltas
 * together. */
function logEvent(text: string) {
  const row = document.createElement("div");
  row.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  sessionLogEl.appendChild(row);
  sessionLogEl.scrollTop = sessionLogEl.scrollHeight;
}

let busy = false;

function updateApplyButtonState() {
  applyFillCavitiesBtnEl.disabled = busy || selectedCavityIds.size === 0;
  applyFillTunnelsBtnEl.disabled = busy || selectedTunnelIds.size === 0;
}

function updateUndoButtonState() {
  undoBtnEl.disabled = busy || !undoPoint;
}

/** Snapshots the live geometry before a mutating operation. Called right
 * before Scale/Optimize/Fill touch `currentMesh.geometry`. */
function pushUndo(label: string) {
  if (!currentMesh) return;
  undoPoint?.geometry.dispose();
  undoPoint = { geometry: currentMesh.geometry.clone(), label, subunitColor, chainLegend, subunitChainIndex };
  updateUndoButtonState();
}

function clearUndo() {
  undoPoint?.geometry.dispose();
  undoPoint = null;
  updateUndoButtonState();
}

function clearVoidsList() {
  cavityDetection = EMPTY_DETECTION;
  tunnelDetection = EMPTY_DETECTION;
  selectedCavityIds.clear();
  selectedTunnelIds.clear();
  cavitiesListEl.innerHTML = "";
  tunnelsListEl.innerHTML = "";
  updateApplyButtonState();
  clearCavityHighlights();
}

/** Removes and disposes cavity highlight meshes and restores the shell's
 * normal opacity. Called whenever detection results go stale — either
 * ALL of them at once (geometry changed by Fill/Optimize/Scale/Undo, new
 * model loaded — the usual case, `kind` omitted), or just one kind's
 * (paired with that kind's own re-detect — see runDetectVoids — so the
 * OTHER kind's highlights stay exactly as they were rather than
 * flickering out and back for a redetect they had nothing to do with). */
function clearCavityHighlights(kind?: "cavity" | "tunnel") {
  for (const [id, entry] of cavityHighlightMeshes) {
    if (kind && entry.kind !== kind) continue;
    currentMesh?.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    cavityHighlightMeshes.delete(id);
  }
  updateShellTransparency();
}

function updateShellTransparency() {
  const show = showVoidHighlightsEl.checked && cavityHighlightMeshes.size > 0;
  MESH_MATERIAL.transparent = show;
  MESH_MATERIAL.opacity = show ? HIGHLIGHT_SHELL_OPACITY : 1;
}

/** Builds one small standalone mesh per cavity/tunnel highlight the worker
 * sent back, as children of currentMesh (so they inherit any spin),
 * colored by whether that void is currently selected to fill (an id is
 * only ever in one of the two selection sets, kind doesn't matter here).
 * Voids are fully enclosed (or, for a tunnel, at least mostly so) inside
 * the shell, so this also makes the shell itself semi-transparent —
 * otherwise every highlight would just render hidden behind opaque outer
 * geometry, which would defeat the entire point.
 *
 * `kind`, when given, scopes this to just that kind's own highlights —
 * `highlights` still arrives as the full combined worker result (one
 * flood-fill pass always finds both), filtered here against `forKind` so
 * a redetect of one kind can't touch the other's highlight meshes. */
function buildCavityHighlights(highlights: ComponentHighlightMesh[], forKind: (id: number) => "cavity" | "tunnel" | undefined, kind?: "cavity" | "tunnel") {
  clearCavityHighlights(kind);
  if (!currentMesh) return;
  for (const h of highlights) {
    const hKind = forKind(h.id);
    if (!hKind || (kind && hKind !== kind)) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(h.position, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(h.normal, 3));
    const included = selectedCavityIds.has(h.id) || selectedTunnelIds.has(h.id);
    const material = new THREE.MeshStandardMaterial({
      color: included ? CAVITY_INCLUDE_COLOR : CAVITY_EXCLUDE_COLOR,
      side: THREE.DoubleSide,
      // The translucent shell still WRITES depth by default even though
      // it blends color — without disabling depth test/write here, its
      // near-side wall would occlude cavities sitting behind it in the
      // depth buffer, defeating the whole point of making it see-through.
      // Rendering highlights after the shell, ignoring depth entirely,
      // guarantees they're always visible regardless of which side of the
      // (single, thin) shell wall they'd otherwise sort behind.
      depthWrite: false,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 999;
    currentMesh.add(mesh);
    cavityHighlightMeshes.set(h.id, { mesh, kind: hKind });
  }
  updateShellTransparency();
}

function updateCavityHighlightColor(id: number) {
  const entry = cavityHighlightMeshes.get(id);
  if (!entry) return;
  const included = selectedCavityIds.has(id) || selectedTunnelIds.has(id);
  (entry.mesh.material as THREE.MeshStandardMaterial).color.setHex(included ? CAVITY_INCLUDE_COLOR : CAVITY_EXCLUDE_COLOR);
}

/** All worker-backed operations share one worker slot — disable the
 * action buttons while any is running so they can't race. */
function setBusy(nextBusy: boolean) {
  busy = nextBusy;
  optimizeBtnEl.disabled = busy || !currentMesh;
  detectCavitiesBtnEl.disabled = busy || !currentMesh;
  detectTunnelsBtnEl.disabled = busy || !currentMesh;
  applyScaleBtnEl.disabled = busy || !currentMesh;
  cancelBtnEl.style.display = busy ? "block" : "none";
  updateApplyButtonState();
  updateUndoButtonState();
}

/** Every worker-backed operation only ever mutates app state (geometry,
 * detected-void lists, etc.) from its FINAL onmessage handler, never
 * incrementally while running — so terminating the worker mid-flight and
 * just resetting `busy` is always safe: whatever was true before the
 * operation started is still true, nothing partial to unwind. */
cancelBtnEl.addEventListener("click", () => {
  if (!worker) return;
  worker.terminate();
  worker = null;
  setBusy(false);
  setStatus("Cancelled.");
  logEvent("Cancelled operation");
});

const helpPanelEl = document.querySelector<HTMLDivElement>("#help-panel")!;
const helpPanelContentEl = document.querySelector<HTMLDivElement>("#help-panel-content")!;
const helpPanelCloseEl = document.querySelector<HTMLButtonElement>("#help-panel-close")!;

function closeHelpPanel() {
  helpPanelEl.classList.remove("open");
}

// One delegated listener on the whole panel covers every "?" button,
// including ones added later (chain legend rows, etc. don't currently add
// any, but nothing here depends on the button existing at wiring time).
controlsPanelEl.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".help-btn");
  if (!btn) return;
  const key = btn.dataset.helpKey;
  if (!key) return;
  helpPanelContentEl.innerHTML = helpContent.get(key) ?? "";
  helpPanelEl.classList.add("open");
});

helpPanelCloseEl.addEventListener("click", closeHelpPanel);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHelpPanel();
});

/** Colors the live mesh by whichever view is active: per-subunit solid
 * colors (from a chain-aware PDB import or a multi-material 3MF), or the
 * usual overhang red/blue. Falls back to overhang coloring whenever
 * subunit data isn't available, matching all prior (STL) behavior.
 *
 * Subunit view still shows overhang need — support-relevant faces get the
 * red overhang tint blended into their chain color rather than
 * disappearing entirely, since which faces need support doesn't stop
 * mattering just because you're looking at chain identity instead. */
function recolorCurrentMesh() {
  if (!currentMesh) return;
  if (showSubunitColorsEl.checked && subunitColor) {
    applySubunitColorsWithOverhangHighlight(currentMesh.geometry, subunitColor, criticalAngleDeg);
  } else {
    applyOverhangColors(currentMesh.geometry, criticalAngleDeg);
  }
  updateOverhangLegend();
}

/** A persistent, always-visible key for the red/blue overhang coloring —
 * kept in sync with recolorCurrentMesh so it can never go stale, and
 * shown right next to the slider that drives it rather than only as a
 * one-off status message. Exists because the coloring appears on the
 * model from the moment a structure loads (well before anyone opens this
 * section, if they ever do), with nothing on screen saying what it means
 * until this — a transient status-bar line the next status message
 * immediately overwrites isn't a substitute for that. */
function updateOverhangLegend() {
  if (!currentMesh) {
    overhangLegendEl.innerHTML = "";
    return;
  }
  const overhangHex = `#${OVERHANG_COLOR_HEX.toString(16).padStart(6, "0")}`;
  const safeHex = `#${SAFE_COLOR_HEX.toString(16).padStart(6, "0")}`;
  overhangLegendEl.innerHTML =
    showSubunitColorsEl.checked && subunitColor
      ? `<span class="legend-swatch" style="background:${overhangHex}"></span>needs support past ${criticalAngleDeg}&deg; — still flagged even with subunit colors on`
      : `<span class="legend-swatch" style="background:${overhangHex}"></span>needs support past ${criticalAngleDeg}&deg; &nbsp; <span class="legend-swatch" style="background:${safeHex}"></span>self-supporting`;
}

/** Enables/disables the toggle based on whether the current mesh actually
 * has subunit color data, and shows/hides the chain legend to match. */
/** Builds the per-vertex chain-index array a freshly loaded/rebuilt PDB or
 * mmCIF mesh needs for palette switching — see subunitChainIndex's own
 * doc comment above. `chains[].triangleStart`/`triangleCount` are in
 * TRIANGLE units (three vertices each), matching how buildChainMeshes
 * reports them. */
function buildSubunitChainIndex(chains: ChainMeshEntry[], vertexCount: number): Int32Array {
  const index = new Int32Array(vertexCount);
  chains.forEach((c, chainIdx) => {
    const start = c.triangleStart * 3;
    const end = start + c.triangleCount * 3;
    for (let v = start; v < end; v++) index[v] = chainIdx;
  });
  return index;
}

/** Regenerates subunitColor from subunitChainIndex + whichever palette is
 * currently selected — the actual "instant switch" (a plain O(vertices)
 * pass, no worker round trip) — and repaints. No-op if the current
 * structure has no real chain identity to recolor from (see
 * subunitChainIndex's doc comment: null for a 3MF import). */
function applyChainPalette(id: ChainPaletteId) {
  chainPaletteId = id;
  if (!subunitChainIndex) return;
  const palette = CHAIN_PALETTES[id];
  const out = new Float32Array(subunitChainIndex.length * 3);
  for (let v = 0; v < subunitChainIndex.length; v++) {
    const c = palette[subunitChainIndex[v] % palette.length];
    out[v * 3] = c[0];
    out[v * 3 + 1] = c[1];
    out[v * 3 + 2] = c[2];
  }
  subunitColor = out;
  recolorCurrentMesh();
  renderChainLegend();
}

chainPaletteSelectEl.addEventListener("change", () => {
  applyChainPalette(chainPaletteSelectEl.value as ChainPaletteId);
});

colorblindSafeColorsEl.addEventListener("change", () => {
  const safe = colorblindSafeColorsEl.checked;
  setOverhangColorMode(safe);
  CAVITY_INCLUDE_COLOR = safe ? COLORBLIND_CAVITY_INCLUDE_COLOR : DEFAULT_CAVITY_INCLUDE_COLOR;
  CAVITY_EXCLUDE_COLOR = safe ? COLORBLIND_CAVITY_EXCLUDE_COLOR : DEFAULT_CAVITY_EXCLUDE_COLOR;

  // The axes gizmo's label color is baked into its own canvas texture at
  // creation time (see createAxesGizmo) — no material property to flip,
  // so swap the whole group out for a freshly built one with the other
  // color triad. refreshVisualization() below reapplies its scale/corner
  // position, same as it does after any model change.
  scene.remove(axesGizmo);
  disposeAxesGizmo(axesGizmo);
  axesGizmo = createAxesGizmo(safe);
  scene.add(axesGizmo);

  // Chain colors are most of what's on screen for a multi-chain structure.
  // Only swap between default and the colorblind palette — a palette the
  // user picked by hand (Tol Muted, Viridis) is left alone either way.
  const nextPalette = safe ? COLORBLIND_CHAIN_PALETTE : "default";
  const prevPalette = safe ? "default" : COLORBLIND_CHAIN_PALETTE;
  if (chainPaletteId === prevPalette) {
    chainPaletteSelectEl.value = nextPalette;
    applyChainPalette(nextPalette);
  }

  recolorCurrentMesh();
  for (const id of cavityHighlightMeshes.keys()) updateCavityHighlightColor(id);
  refreshVisualization();
});

function updateSubunitToggleState() {
  showSubunitColorsEl.disabled = !subunitColor;
  if (!subunitColor) showSubunitColorsEl.checked = false;
  // Palette switching needs real chain identity per vertex, not just SOME
  // color array — a 3MF import's colors are whatever that file's own
  // materials specified, with no chain index behind them to recolor from.
  chainPaletteSelectEl.disabled = !subunitChainIndex;
  renderChainLegend();
}

function renderChainLegend() {
  chainLegendEl.innerHTML = "";
  if (!chainLegend || !showSubunitColorsEl.checked) return;
  const palette = CHAIN_PALETTES[chainPaletteId];
  chainLegend.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "legend-row";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    // Reflects the CURRENTLY selected palette, not whatever color this
    // chain was originally assigned at load time — chainLegend's own
    // .color field is frozen to the default palette and only used as a
    // fallback for a structure that somehow has chain identity without a
    // chain index (shouldn't happen, but degrading to something sane
    // beats an undefined swatch).
    const [r, g, b] = subunitChainIndex ? palette[i % palette.length] : c.color;
    swatch.style.background = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
    row.appendChild(swatch);
    row.append(` Chain ${c.chain} — ${c.triangleCount.toLocaleString()} tri`);
    chainLegendEl.appendChild(row);
  });
}

// generateSupportPaths's dominant cost (per-root landing raycasts) is
// O(roots × candidates-per-cell) now that support-paths.ts bins triangles
// by (u,v) footprint instead of scanning all of them — genuinely linear in
// triangle count, not quadratic — and it runs in a dedicated worker (below)
// rather than blocking the main thread, so this ceiling exists only as a
// sanity backstop against pathological inputs (e.g. a degenerate mesh that
// defeats the spatial index, or just "big enough that waiting isn't worth
// it"), not a real performance limit reached in ordinary use — repeated
// Fill/Optimize passes on a large structure can realistically push well
// past a million triangles.
const SUPPORT_PATH_TRIANGLE_LIMIT = 3_000_000;
const COMPARISON_GAP_FRACTION = 0.15;

function boundingRadiusOf(geometry: THREE.BufferGeometry): number {
  geometry.computeBoundingBox();
  return geometry.boundingBox!.getSize(new THREE.Vector3()).length() / 2;
}

// Support-path generation gets its own persistent worker, separate from
// the module's main `worker` variable — that one is busy/cancel-gated
// (disables Optimize/Export, shows the Cancel button) for genuinely heavy
// user-initiated operations, which would be the wrong UX for what's really
// a lightweight background visualization refresh triggered by a checkbox
// or an angle-slider drag. Requests are tagged with an id so responses
// route back to the right caller even if several are in flight at once
// (the worker processes them in order, but callers can fire a new request
// before an older one's response has arrived).
let supportPathsWorker: Worker | null = null;
let nextSupportPathsRequestId = 1;
/** Bumped once per refreshVisualization() call — a callback whose captured
 * generation no longer matches belongs to a superseded refresh (or a mesh
 * that's since been replaced entirely) and should be dropped. */
let supportPathsRefreshGeneration = 0;
const pendingSupportPathsCallbacks = new Map<number, (result: SupportPathsResult | null, error?: string) => void>();

function segmentsToSupportPathsResult(segments: Float32Array, rootCount: number, totalLength: number): SupportPathsResult {
  const paths: SupportPathsResult["paths"] = [];
  for (let i = 0; i < segments.length; i += 6) {
    const a = new THREE.Vector3(segments[i], segments[i + 1], segments[i + 2]);
    const b = new THREE.Vector3(segments[i + 3], segments[i + 4], segments[i + 5]);
    paths.push({ points: [a, b] });
  }
  return { paths, rootCount, totalLength };
}

function getSupportPathsWorker(): Worker {
  if (!supportPathsWorker) {
    supportPathsWorker = new GeometryWorker();
    supportPathsWorker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type !== "support-paths-result") return;
      const callback = pendingSupportPathsCallbacks.get(msg.requestId);
      if (!callback) return;
      pendingSupportPathsCallbacks.delete(msg.requestId);
      callback(msg.error ? null : segmentsToSupportPathsResult(msg.segments, msg.rootCount, msg.totalLength), msg.error);
    };
  }
  return supportPathsWorker;
}

/** Fires off an async support-path request; `onResult` is called exactly
 * once, with `null` (and no error) if the mesh is over the triangle
 * ceiling, or `null` plus `error` if generation itself threw (an
 * illustrative-only feature — real structures occasionally hit a
 * clustering/raycast edge case synthetic fixtures didn't cover; degrading
 * to "no paths shown" beats taking down the whole visualization refresh). */
function requestSupportPaths(geometry: THREE.BufferGeometry, onResult: (result: SupportPathsResult | null, error?: string) => void) {
  const position = geometry.attributes.position.array as Float32Array;
  const normal = geometry.attributes.normal.array as Float32Array;
  if (position.length / 9 > SUPPORT_PATH_TRIANGLE_LIMIT) {
    onResult(null);
    return;
  }
  const requestId = nextSupportPathsRequestId++;
  pendingSupportPathsCallbacks.set(requestId, onResult);
  const request: GenerateSupportPathsRequest = {
    type: "generate-support-paths",
    requestId,
    position: position.slice(),
    normal: normal.slice(),
    criticalAngleDeg,
    style: supportStyleSelectEl.value as SupportStyle,
  };
  getSupportPathsWorker().postMessage(request, [request.position.buffer, request.normal.buffer]);
}

/** Adds a text label as a CHILD of `parent` (the mesh it describes) —
 * positioned once in `parent`'s local space (which starts out identical
 * to world space, since mesh.position/quaternion stay identity until a
 * drag-to-spin moves them), so the label rides along automatically when
 * the mesh is spun for inspection. */
function addLabelAbove(geometry: THREE.BufferGeometry, text: string, parent: THREE.Object3D): THREE.Sprite {
  const box = geometry.boundingBox!;
  const radius = boundingRadiusOf(geometry);
  const sprite = createTextSprite(text, "#dddddd", {
    textAlign: "center",
    scaleWidth: radius * 1.1,
    scaleHeight: radius * 0.28,
  });
  sprite.position.set((box.max.x + box.min.x) / 2, (box.max.y + box.min.y) / 2, box.max.z + radius * 0.15);
  parent.add(sprite);
  return sprite;
}

/** Removes and disposes every comparison/support-path visual currently
 * in the scene — the clean slate every refresh rebuilds from. Support
 * paths and labels are children of the mesh they belong to (see
 * addLabelAbove), so they must be detached from THAT parent explicitly —
 * currentMesh persists across refreshes, so nulling a variable alone
 * would leave a stale child attached to it forever. */
function clearVisualExtras() {
  if (supportPathsGroup) {
    currentMesh?.remove(supportPathsGroup);
    disposeSupportPathsGroup(supportPathsGroup);
    supportPathsGroup = null;
  }
  if (currentLabel) {
    currentMesh?.remove(currentLabel);
    currentLabel = null;
  }
  if (comparisonSupportPathsGroup) {
    comparisonMesh?.remove(comparisonSupportPathsGroup);
    disposeSupportPathsGroup(comparisonSupportPathsGroup);
    comparisonSupportPathsGroup = null;
  }
  if (comparisonLabel) {
    comparisonMesh?.remove(comparisonLabel);
    comparisonLabel = null;
  }
  if (comparisonMesh) {
    scene.remove(comparisonMesh);
    comparisonMesh.geometry.dispose();
    comparisonMesh = null;
  }
}

function updateScaleSizeDisplay() {
  if (!currentMesh) {
    scaleCurrentSizeEl.textContent = "";
    return;
  }
  currentMesh.geometry.computeBoundingBox();
  const box = currentMesh.geometry.boundingBox!;
  const dx = box.max.x - box.min.x, dy = box.max.y - box.min.y, dz = box.max.z - box.min.z;
  scaleCurrentSizeEl.textContent = `Current size: ${dx.toFixed(2)} × ${dy.toFixed(2)} × ${dz.toFixed(2)} mm`;
}

/** Rebuilds whatever combination of support-path tubes and the
 * before/after comparison ghost the checkboxes currently call for, then
 * reframes the camera and updates the stats panel. Recoloring on angle
 * change is cheap and already live elsewhere; this covers the heavier,
 * checkbox-gated visuals. */
function refreshVisualization() {
  clearVisualExtras();
  updateScaleSizeDisplay();
  if (!currentMesh) {
    statsPanelEl.innerHTML = "";
    return;
  }

  const currentBox = (() => {
    currentMesh!.geometry.computeBoundingBox();
    return currentMesh!.geometry.boundingBox!;
  })();

  let currentResult: SupportPathsResult | null = null;
  let startResult: SupportPathsResult | null = null;
  const framingTargets: THREE.Object3D[] = [currentMesh];
  const thisGeneration = ++supportPathsRefreshGeneration;

  if (showComparisonEl.checked && originalGeometry) {
    const geometry = originalGeometry.clone();
    geometry.computeBoundingBox();
    const startBox = geometry.boundingBox!;
    // Place the start-model clone directly to the left of the current
    // model with a visible gap: its translated max.x should land exactly
    // `gap` before the current model's min.x.
    const gap = (currentBox.max.x - currentBox.min.x) * COMPARISON_GAP_FRACTION + 1;
    const offsetX = currentBox.min.x - gap - startBox.max.x;
    geometry.translate(offsetX, 0, 0);
    geometry.computeBoundingBox();
    // Same subunit-vs-overhang choice as the live mesh (recolorCurrentMesh
    // above) — subunitColor's length only ever matches the geometry it was
    // captured from (load time, or right after a scale, which doesn't
    // change vertex count), so the length check is a defensive guard
    // against a stale array rather than something expected to trip often.
    if (showSubunitColorsEl.checked && subunitColor && subunitColor.length === geometry.attributes.position.count * 3) {
      applySubunitColorsWithOverhangHighlight(geometry, subunitColor, criticalAngleDeg);
    } else {
      applyOverhangColors(geometry, criticalAngleDeg);
    }

    comparisonMesh = new THREE.Mesh(geometry, COMPARISON_MESH_MATERIAL);
    scene.add(comparisonMesh);
    framingTargets.push(comparisonMesh);

    comparisonLabel = addLabelAbove(geometry, "Start", comparisonMesh);
    currentLabel = addLabelAbove(currentMesh.geometry, "Optimized", currentMesh);
  }

  if (showSupportPathsEl.checked) {
    // Fires async against the dedicated support-paths worker (see above) —
    // tagged with `thisGeneration` plus a mesh/geometry identity check so a
    // response that lands after a newer refresh (or a whole new model load)
    // superseded it gets dropped instead of attaching stale tubes to the
    // wrong mesh.
    const targetMesh = currentMesh;
    const targetGeometry = targetMesh.geometry;
    requestSupportPaths(targetGeometry, (result, error) => {
      if (thisGeneration !== supportPathsRefreshGeneration) return;
      if (currentMesh !== targetMesh || currentMesh.geometry !== targetGeometry) return;
      if (result) {
        currentResult = result;
        supportPathsGroup = buildSupportPathsGroup(result, boundingRadiusOf(targetGeometry));
        currentMesh.add(supportPathsGroup);
      } else if (error) {
        setStatus(`Support paths failed on this mesh (${error}) — showing the model without them.`, true);
      } else {
        setStatus(`Support paths skipped — mesh has too many triangles (over ${SUPPORT_PATH_TRIANGLE_LIMIT.toLocaleString()})`, true);
      }
      updateStatsPanel(currentResult, startResult);
    });

    if (comparisonMesh) {
      const compMesh = comparisonMesh;
      const compGeometry = compMesh.geometry;
      requestSupportPaths(compGeometry, (result) => {
        if (thisGeneration !== supportPathsRefreshGeneration) return;
        if (comparisonMesh !== compMesh) return;
        if (result) {
          startResult = result;
          comparisonSupportPathsGroup = buildSupportPathsGroup(result, boundingRadiusOf(compGeometry));
          compMesh.add(comparisonSupportPathsGroup);
        }
        updateStatsPanel(currentResult, startResult);
      });
    }
  }

  // Combined footprint of everything actually being shown (just the live
  // mesh normally; live + comparison ghost when that's on) — drives the
  // build plate's size and the axes gizmo's scale/corner position so both
  // track whatever's on screen instead of a size fixed at construction
  // time, which reads as "the model is bigger than the bed" for anything
  // much over 200mm or once a comparison ghost is offset outside it.
  const combinedBox = new THREE.Box3();
  for (const target of framingTargets) combinedBox.expandByObject(target);
  const combinedSize = combinedBox.getSize(new THREE.Vector3());
  const combinedMaxDim = Math.max(combinedSize.x, combinedSize.y, combinedSize.z, 1e-6);

  scaleBuildPlate(buildPlate, combinedMaxDim * 1.3);
  const gizmoArrowLength = combinedMaxDim * 0.2;
  scaleAxesGizmo(axesGizmo, gizmoArrowLength);
  positionAxesGizmoAtCorner(axesGizmo, combinedBox, gizmoArrowLength);

  frameObject(framingTargets, camera, controls);
  updateStatsPanel(currentResult, startResult);
}

function updateStatsPanel(current: SupportPathsResult | null, start: SupportPathsResult | null) {
  if (!current && !start) {
    statsPanelEl.innerHTML = "";
    return;
  }
  const lines: string[] = [];
  if (current) {
    lines.push(`Support: ${current.rootCount} points, ${current.totalLength.toFixed(1)}mm of paths`);
  }
  if (start && current) {
    // Round to whole percent before display so near-zero float noise
    // (e.g. -0.0001%) can't render as a stray "-0%".
    const lengthReductionPct = Math.round(start.totalLength > 0 ? (1 - current.totalLength / start.totalLength) * 100 : 0) || 0;
    const rootReductionPct = Math.round(start.rootCount > 0 ? (1 - current.rootCount / start.rootCount) * 100 : 0) || 0;
    lines.push(`Start: ${start.rootCount} points, ${start.totalLength.toFixed(1)}mm`);
    lines.push(`Reduction: ${rootReductionPct}% fewer points, ${lengthReductionPct}% less path length`);
  }
  statsPanelEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
}

const MAX_VOIDS_SHOWN = 20;

// A real sealed pocket — even a large one — is always a small fraction of
// the model's own volume, since it has to fit entirely inside solid
// material. Something at or past this share of the detection grid's
// volume is a sign the flood-fill swept in the open space around/between
// distant parts of the structure rather than a genuine local void (see
// VoidComponentSummary.volumeFraction) — filling it would concatenate a
// patch roughly as large as the model itself onto the exterior. 20% is
// deliberately generous (a real cavity is typically well under 1%) so
// this only ever fires on the pathological case, not a legitimately large
// pocket.
const OVERSIZED_VOID_FRACTION = 0.2;

/** Renders one kind's own detection record into its own list
 * container/selection set — both Cavities and Tunnels go through this,
 * differing only in which record/container/set/default they pass in.
 * Both kinds are fillable now (see buildSealPatchMesh, which never
 * actually looked at `kind` — only which detection component a seal is
 * built from), so both get a real checkbox, not a readonly row. */
function renderVoidGroupList(container: HTMLDivElement, kind: "cavity" | "tunnel", selectedIds: Set<number>, autoIncludeHidden: boolean) {
  container.innerHTML = "";
  const record = detectionFor(kind);
  const components = record.components;
  if (components.length === 0) return;

  const shown = components.slice(0, MAX_VOIDS_SHOWN);
  const hidden = components.slice(MAX_VOIDS_SHOWN);
  const label = kind === "cavity" ? "Cavity" : "Tunnel";

  for (const c of shown) {
    const volumeMm3 = c.voxelCount * record.voxelSize ** 3;
    const percentOfModel = c.volumeFraction * 100;
    const oversized = c.volumeFraction >= OVERSIZED_VOID_FRACTION;
    const row = document.createElement("label");
    row.className = oversized ? "void-row void-row-oversized" : "void-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedIds.has(c.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(c.id);
      else selectedIds.delete(c.id);
      updateApplyButtonState();
      updateCavityHighlightColor(c.id);
    });
    row.appendChild(checkbox);
    // Percentage of the model's own volume, not just a raw voxel count —
    // a raw number doesn't convey scale, which is exactly what matters
    // here: something covering a large share of the model isn't a real
    // pocket, it's the flood-fill sweeping in open space around/between
    // distant parts of the structure (see OVERSIZED_VOID_FRACTION).
    const sizeLabel = percentOfModel >= 1
      ? `${percentOfModel.toFixed(0)}% of model`
      : `${c.voxelCount.toLocaleString()} voxels (~${volumeMm3.toFixed(1)} mm³)`;
    row.append(` ${label} — ${sizeLabel}`);
    if (oversized) {
      const warning = document.createElement("span");
      warning.className = "void-row-warning";
      warning.textContent = " — too large to fill safely";
      row.appendChild(warning);
    }
    container.appendChild(row);
  }

  if (hidden.length > 0) {
    const note = document.createElement("div");
    note.className = "void-row-readonly";
    note.textContent = autoIncludeHidden
      ? `+ ${hidden.length} more small ${label.toLowerCase()}${hidden.length === 1 ? "" : "s"} (all included by default)`
      : `+ ${hidden.length} more small ${label.toLowerCase()}${hidden.length === 1 ? "" : "s"} (not listed — none pre-selected)`;
    container.appendChild(note);
    if (autoIncludeHidden) for (const c of hidden) selectedIds.add(c.id);
  }
}

/** Sweeps the shared clip plane across the current mesh's X extent so
 * dragging the slider reveals internal cavities — 0% shows the whole
 * model, 100% clips it all away. Re-reads the bounding box each call
 * since it changes after every load or reorientation. */
function updateClipPlane() {
  if (!currentMesh?.geometry.boundingBox) return;
  const box = currentMesh.geometry.boundingBox;
  const t = Number(clipSliderEl.value) / 100;
  const cutX = THREE.MathUtils.lerp(box.min.x - 1, box.max.x + 1, t);
  clipPlane.constant = -cutX;
}

/** Any drag-to-spin view rotation (see the pointer handlers below) is
 * display-only — geometry is the only thing that ever holds the "real"
 * orientation. Called whenever the geometry itself changes (scale, fill,
 * optimize) so a leftover spin from inspecting the previous state doesn't
 * carry over and look like part of the new result. */
function resetMeshSpin(mesh: THREE.Mesh) {
  mesh.position.set(0, 0, 0);
  mesh.quaternion.identity();
}

// Drag-to-spin: lets the user inspect the current model and/or the
// comparison "start" ghost by dragging directly on them, independent of
// the shared-camera orbit. Purely a view transform — see resetMeshSpin
// above for why this is safe to keep separate from geometry.
const spinRaycaster = new THREE.Raycaster();
let spinMesh: THREE.Mesh | null = null;
const spinPivot = new THREE.Vector3();
let spinLastX = 0;
let spinLastY = 0;
const SPIN_SENSITIVITY = 0.008;
const worldUp = new THREE.Vector3(0, 0, 1);

function spinCandidates(): THREE.Mesh[] {
  const list: THREE.Mesh[] = [];
  if (currentMesh) list.push(currentMesh);
  if (comparisonMesh) list.push(comparisonMesh);
  return list;
}

function pointerToNDC(event: PointerEvent): THREE.Vector2 {
  const rect = viewerEl.getBoundingClientRect();
  return new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

function onSpinPointerMove(event: PointerEvent) {
  if (!spinMesh) return;
  const dx = event.clientX - spinLastX;
  const dy = event.clientY - spinLastY;
  spinLastX = event.clientX;
  spinLastY = event.clientY;

  const cameraRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const yawQuat = new THREE.Quaternion().setFromAxisAngle(worldUp, -dx * SPIN_SENSITIVITY);
  const pitchQuat = new THREE.Quaternion().setFromAxisAngle(cameraRight, -dy * SPIN_SENSITIVITY);
  const deltaQuat = pitchQuat.multiply(yawQuat);

  // Premultiplying applies the delta in world space on top of whatever
  // spin is already accumulated, then re-derives position from the fixed
  // local pivot so the mesh visually spins about its own center rather
  // than orbiting away from it (see resetMeshSpin's invariant note).
  spinMesh.quaternion.premultiply(deltaQuat);
  spinMesh.position.copy(spinPivot).sub(spinPivot.clone().applyQuaternion(spinMesh.quaternion));
}

function onSpinPointerUp() {
  spinMesh = null;
  controls.enabled = true;
  viewerEl.style.cursor = "";
  window.removeEventListener("pointermove", onSpinPointerMove);
  window.removeEventListener("pointerup", onSpinPointerUp);
}

// Registered with {capture: true} on viewerEl (an ancestor of the
// renderer's canvas) so this runs BEFORE OrbitControls' own pointerdown
// listener, which sits directly on the canvas in the bubble phase.
// stopPropagation on a hit stops the event from ever reaching that
// listener, so a mesh-drag doesn't also orbit the camera.
function onSpinPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const candidates = spinCandidates();
  if (candidates.length === 0) return;

  spinRaycaster.setFromCamera(pointerToNDC(event), camera);
  const hits = spinRaycaster.intersectObjects(candidates, false);
  if (hits.length === 0) return;

  spinMesh = hits[0].object as THREE.Mesh;
  spinMesh.geometry.computeBoundingBox();
  spinMesh.geometry.boundingBox!.getCenter(spinPivot);
  spinLastX = event.clientX;
  spinLastY = event.clientY;
  controls.enabled = false;
  viewerEl.style.cursor = "grabbing";
  event.stopPropagation();
  window.addEventListener("pointermove", onSpinPointerMove);
  window.addEventListener("pointerup", onSpinPointerUp);
}

viewerEl.addEventListener("pointerdown", onSpinPointerDown, { capture: true });

undoBtnEl.addEventListener("click", () => {
  if (!currentMesh || !undoPoint || busy) return;
  const { geometry, label, subunitColor: savedColor, chainLegend: savedLegend, subunitChainIndex: savedChainIndex } = undoPoint;
  currentMesh.geometry.dispose();
  currentMesh.geometry = geometry;
  subunitColor = savedColor;
  chainLegend = savedLegend;
  subunitChainIndex = savedChainIndex;
  updateSubunitToggleState();
  resetMeshSpin(currentMesh);
  recolorCurrentMesh();
  updateClipPlane();
  clearVoidsList(); // mesh changed — previous detection ids no longer apply
  undoPoint = null;
  updateUndoButtonState();
  refreshVisualization();
  setStatus(`Undid last ${label}.`);
  logEvent(`Undid ${label}`);
});

scaleModeEl.addEventListener("change", () => {
  const isPercent = scaleModeEl.value === "percent";
  scalePercentRowEl.style.display = isPercent ? "flex" : "none";
  scaleAbsoluteRowEl.style.display = isPercent ? "none" : "flex";
});

applyScaleBtnEl.addEventListener("click", () => {
  if (!currentMesh || busy) return;

  const geometry = currentMesh.geometry;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const dx = box.max.x - box.min.x, dy = box.max.y - box.min.y, dz = box.max.z - box.min.z;

  let factor: number;
  if (scaleModeEl.value === "percent") {
    const pct = Number(scalePercentEl.value);
    if (!Number.isFinite(pct) || pct <= 0) {
      setStatus("Enter a positive percentage.", true);
      return;
    }
    factor = pct / 100;
  } else {
    const target = Number(scaleTargetEl.value);
    if (!Number.isFinite(target) || target <= 0) {
      setStatus("Enter a positive target size.", true);
      return;
    }
    const axis = scaleAxisEl.value;
    const current = axis === "x" ? dx : axis === "y" ? dy : axis === "z" ? dz : Math.max(dx, dy, dz);
    if (current <= 0) {
      setStatus("Model has zero size along that axis.", true);
      return;
    }
    factor = target / current;
  }

  pushUndo("scale");

  // Uniform scale — same factor on all three axes — so proportions never
  // distort, only overall size changes.
  geometry.scale(factor, factor, factor);
  placeOnBuildPlate(geometry);
  resetMeshSpin(currentMesh);
  recolorCurrentMesh();
  updateClipPlane();

  // Scaling redefines the model's own reference size, so the scaled
  // result becomes the new "start" baseline for the comparison view —
  // comparing against the pre-scale (wrong-size) geometry wouldn't mean
  // anything once the user has deliberately resized it.
  originalGeometry?.dispose();
  originalGeometry = geometry.clone();
  clearVoidsList();

  geometry.computeBoundingBox();
  const newBox = geometry.boundingBox!;
  const newDx = newBox.max.x - newBox.min.x, newDy = newBox.max.y - newBox.min.y, newDz = newBox.max.z - newBox.min.z;

  refreshVisualization();
  const scaleStatus = `Scaled to ${(factor * 100).toFixed(2)}% (now ${newDx.toFixed(2)} × ${newDy.toFixed(2)} × ${newDz.toFixed(2)} mm)`;
  setStatus(scaleStatus);
  logEvent(scaleStatus);
});

angleValueEl.textContent = String(criticalAngleDeg);
angleSliderEl.addEventListener("input", () => {
  criticalAngleDeg = Number(angleSliderEl.value);
  angleValueEl.textContent = String(criticalAngleDeg);
  recolorCurrentMesh();
});
// Support-path generation is heavier than recoloring — only recompute it
// once the user settles on a value, not on every drag tick.
angleSliderEl.addEventListener("change", refreshVisualization);

clipSliderEl.addEventListener("input", () => {
  const value = Number(clipSliderEl.value);
  clipValueEl.textContent = value === 0 ? "off" : `${value}%`;
  updateClipPlane();
});

function resetClipSlider() {
  if (clipSliderEl.value === "0") return;
  clipSliderEl.value = "0";
  clipValueEl.textContent = "off";
  updateClipPlane();
}
clipSliderEl.addEventListener("dblclick", resetClipSlider);
clipResetBtnEl.addEventListener("click", resetClipSlider);

showVoidHighlightsEl.addEventListener("change", updateShellTransparency);

cavityThresholdCustomEl.addEventListener("change", () => {
  cavityThresholdRowEl.style.display = cavityThresholdCustomEl.checked ? "flex" : "none";
});
cavityThresholdSliderEl.addEventListener("input", () => {
  cavityThresholdValueEl.textContent = `≤ ${Number(cavityThresholdSliderEl.value).toLocaleString()} voxels`;
});

showSupportPathsEl.addEventListener("change", refreshVisualization);
supportStyleSelectEl.addEventListener("change", refreshVisualization);
showComparisonEl.addEventListener("change", refreshVisualization);
showSubunitColorsEl.addEventListener("change", () => {
  recolorCurrentMesh();
  renderChainLegend();
  refreshVisualization();
  // Switching subunit colors off reveals the overhang coloring underneath,
  // whose large red patches read as a rendering artifact ("why did my
  // model get a red shadow?") unless it's said plainly what they mean.
  setStatus(
    showSubunitColorsEl.checked
      ? "Showing subunit colors — one color per chain."
      : `Showing overhang colors — red marks faces leaning past ${criticalAngleDeg}° that would need support in the current orientation, blue marks self-supporting faces. Not a rendering artifact.`,
  );
});

interface SubunitData {
  color: Float32Array;
  chains: ChainMeshEntry[] | null;
  /** Whether the subunit-color view should be ON by default for this
   * load — true for a genuinely multi-part PDB (>1 chain) or any 3MF
   * (imported specifically for its own coloring); false for a
   * single-chain PDB, where showing the usual overhang colors first
   * matches everything tested/expected so far. */
  defaultOn: boolean;
}

/** Common tail of every "a new mesh just replaced the working model" path
 * (STL/PDB/3MF drop) — resets everything that's tied to the OLD mesh's
 * identity (comparison baseline, undo point, void selection, view
 * toggles) so nothing from a previous structure leaks into the new one. */
function handleLoadedMesh(mesh: THREE.Mesh, baseName: string, statusMessage: string, subunitData?: SubunitData | null) {
  if (currentMesh) {
    scene.remove(currentMesh);
    currentMesh.geometry.dispose();
  }
  currentMesh = mesh;
  currentBaseName = baseName;

  subunitColor = subunitData?.color ?? null;
  chainLegend = subunitData?.chains ?? null;
  subunitChainIndex = chainLegend ? buildSubunitChainIndex(chainLegend, mesh.geometry.attributes.position.count) : null;
  const startPalette: ChainPaletteId = colorblindSafeColorsEl.checked ? COLORBLIND_CHAIN_PALETTE : "default";
  chainPaletteSelectEl.value = startPalette;
  // The worker always colors chains with the default palette, so a load
  // while colorblind mode is on has to be re-colored before it's baked in.
  applyChainPalette(startPalette);
  showSubunitColorsEl.checked = !!subunitData?.defaultOn;
  updateSubunitToggleState();
  // Bake the initial subunit coloring into the geometry BEFORE cloning it
  // as the comparison baseline, so "Start" (in the side-by-side view)
  // keeps showing subunit colors even after later operations (Scale,
  // Optimize) change what's currently painted onto the live mesh.
  if (subunitColor) mesh.geometry.setAttribute("color", new THREE.BufferAttribute(subunitColor.slice(), 3));

  originalGeometry?.dispose();
  originalGeometry = mesh.geometry.clone();
  scene.add(mesh);
  recolorCurrentMesh();
  clipSliderEl.value = "0";
  clipValueEl.textContent = "off";
  updateClipPlane();
  clearVoidsList();
  clearUndo();
  showSupportPathsEl.checked = false;
  showComparisonEl.checked = false;
  refreshVisualization();
  const triCount = mesh.geometry.attributes.position.count / 3;
  // Used to auto-check the proxy box; now just advises instead — the user
  // decides whether the (real) speed-vs-search-thoroughness tradeoff is
  // worth it for this model, rather than it being silently opted into
  // (which was also easy to mistake for something else — e.g. Fill's own
  // resolution setting — quietly making a later Optimize/export coarser).
  proxyAdvisoryEl.style.display = triCount > DIRECT_COST_EVAL_TRIANGLE_LIMIT ? "block" : "none";
  useProxyEl.checked = false;
  exportBtnEl.disabled = false;
  export3mfBtnEl.disabled = false;
  setBusy(false);
  setStatus(statusMessage);
  logEvent(statusMessage);
}

/** Shared by drag-and-drop and the "Browse…" file-picker button — both
 * just need to hand this a File, everything downstream (format sniffing,
 * worker dispatch, handleLoadedMesh) is identical either way. */
function loadFile(file: File) {
    if (worker) {
      setStatus("Busy with another operation — wait for it to finish before loading a new file.", true);
      return;
    }

    const lower = file.name.toLowerCase();
    // Only .pdb/.cif carry atom records, so any other format clears the
    // chain-subset control rather than leaving a previous structure's
    // chain list pointing at atoms that no longer describe what's loaded.
    if (!lower.endsWith(".pdb") && !lower.endsWith(".cif")) {
      loadedAtoms = null;
      chainFilterRowEl.style.display = "none";
      heteroFilterRowEl.style.display = "none";
    }
    if (lower.endsWith(".stl")) {
      loadSTLFile(file)
        .then((mesh) => {
          const vertexCount = mesh.geometry.attributes.position.count;
          handleLoadedMesh(mesh, file.name.replace(/\.stl$/i, ""), `Loaded ${file.name} — ${vertexCount.toLocaleString()} vertices`);
        })
        .catch((err) => setStatus(err instanceof Error ? err.message : "Failed to parse STL file", true));
      return;
    }

    if (lower.endsWith(".3mf")) {
      // 3MF parsing (unzip + XML) is cheap enough to run on the main
      // thread — unlike PDB's voxelize+marching-cubes step, there's no
      // heavy geometry generation here, just reading what's already a
      // triangle mesh.
      file.arrayBuffer().then((buffer) => {
        const parsed = parse3MF(buffer);
        const normal = computeFlatNormals(parsed.position);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(parsed.position, 3));
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
        const mesh = buildMeshFromGeometry(geometry);
        const triCount = parsed.position.length / 9;
        handleLoadedMesh(
          mesh,
          file.name.replace(/\.3mf$/i, ""),
          `Loaded ${file.name} — ${triCount.toLocaleString()} triangles (multi-material)`,
          { color: parsed.color, chains: null, defaultOn: true },
        );
      }).catch((err) => setStatus(err instanceof Error ? err.message : "Failed to parse 3MF file", true));
      return;
    }

    // .pdb / .cif — reading the file itself is quick, but PARSING it
    // (tokenizing every atom record) plus voxelizing and remeshing is the
    // same class of work as Optimize/Fill, so both now go through the
    // shared worker slot together — see buildSurfaceFromText. Both formats
    // produce the identical Atom[] shape, so everything past parsing is
    // format-agnostic.
    const isCIF = lower.endsWith(".cif");
    setStatus(`Reading ${file.name}…`);
    file.text().then((text) => {
      buildSurfaceFromText(text, isCIF ? "cif" : "pdb", file.name, file.name.replace(/\.(pdb|cif)$/i, ""));
    }).catch((err) => {
      setStatus(err instanceof Error ? err.message : "Failed to read the file", true);
    });
}

/** Voxelizes an atom set into a molecular surface via the worker and hands
 * the result to handleLoadedMesh. Shared by the initial .pdb/.cif load and
 * by the chain-subset rebuild, which differ only in which atoms they pass
 * in — so a rebuild reuses the already-parsed records rather than
 * re-reading or re-fetching the source file. */
/** "Auto" scales the grid down as atom count grows so voxelize+
 * marching-cubes stays tractable on very large structures — same tradeoff
 * the orientation-search proxy makes, just sized against atom count
 * instead of triangle count. The worker resolves "auto" into an actual
 * number itself (see resolveAutoResolution in geometry-worker.ts) — this
 * only reads the control's raw value, unparsed. */
function currentResolutionChoice(): number | "auto" {
  const value = importResolutionEl.value;
  return value === "auto" ? "auto" : Number(value);
}

/** Shared by both surface-build paths below: wires up progress/result
 * handling for a "voxelize-pdb" request already built by the caller.
 * `atomCountHint` is shown in status messages before the real atom count
 * is known (the text-based path only learns it once parsing, which now
 * runs worker-side, actually finishes). */
function runVoxelizePdb(request: VoxelizePDBRequest, sourceLabel: string, baseName: string, atomCountHint: string, transfer: Transferable[]) {
  if (worker) {
    setStatus("Busy with another operation — wait for it to finish.", true);
    return;
  }
  setBusy(true);
  setStatus(`Building surface from ${atomCountHint}…`);

  let atomCount = request.atoms?.length ?? 0;

  worker = new GeometryWorker();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      setStatus(`Building surface from ${atomCount ? atomCount.toLocaleString() + " atoms" : atomCountHint}… ${Math.round(msg.fraction * 100)}%`);
      return;
    }
    if (msg.type === "atoms-parsed") {
      // Parsing (worker-side now) just finished — the atom count and
      // chosen resolution are both known for the first time, and the
      // chain-subset dropdown can be populated without waiting for the
      // (potentially much longer) voxelize+remesh pass that follows.
      atomCount = msg.atoms.length;
      loadedAtoms = msg.atoms;
      populateChainFilter(msg.atoms);
      populateHeteroFilter(msg.atoms);
      setStatus(`Building surface from ${atomCount.toLocaleString()} atoms (grid ${msg.resolution}³)…`);
      return;
    }
    if (msg.type === "parse-error") {
      worker?.terminate();
      worker = null;
      setBusy(false);
      setStatus(`"${sourceLabel}" ${msg.message === "no readable atom records" ? "has no readable atom records." : `could not be parsed: ${msg.message}`}`, true);
      return;
    }
    if (msg.type !== "pdb-mesh-result") return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(msg.position, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(msg.normal, 3));
    const mesh = buildMeshFromGeometry(geometry);
    const triCount = msg.position.length / 9;
    const chainNote = msg.chains.length > 1 ? ` across ${msg.chains.length} chains` : "";
    worker?.terminate();
    worker = null;
    handleLoadedMesh(
      mesh,
      baseName,
      `Loaded ${sourceLabel} — ${msg.atomCount.toLocaleString()} atoms → ${triCount.toLocaleString()} triangles${chainNote}`,
      { color: msg.color, chains: msg.chains, defaultOn: msg.chains.length > 1 },
    );
  };

  worker.postMessage(request, transfer);
}

/** Rebuilds the surface from an already-parsed atom set — the chain-
 * subset control's path, which never needs to re-read or re-fetch
 * anything since the atoms are already in memory. */
function buildSurfaceFromAtoms(atoms: Atom[], sourceLabel: string, baseName: string) {
  const request: VoxelizePDBRequest = { type: "voxelize-pdb", atoms, resolution: currentResolutionChoice() };
  runVoxelizePdb(request, sourceLabel, baseName, `${atoms.length.toLocaleString()} atoms`, []);
}

/** Parses and builds the surface from raw .pdb/.cif source text — the
 * initial-load path. Parsing runs inside the worker (see geometry-
 * worker.ts), not here, so a large file's tokenization cost never blocks
 * the main thread with no progress feedback, which is what it did when
 * this ran synchronously in loadFile before the worker even started. */
function buildSurfaceFromText(text: string, format: "cif" | "pdb", sourceLabel: string, baseName: string) {
  loadedAtomsBaseName = baseName;
  loadedAtomsSourceLabel = sourceLabel;
  const request: VoxelizePDBRequest = {
    type: "voxelize-pdb",
    text,
    format,
    resolution: currentResolutionChoice(),
  };
  runVoxelizePdb(request, sourceLabel, baseName, "the file", []);
}

/** Fills the chain-subset dropdown from whatever chains the loaded atom
 * records actually contain. Hidden entirely for a single-chain structure,
 * where subsetting would be a no-op. */
function populateChainFilter(atoms: Atom[]) {
  const counts = new Map<string, number>();
  for (const a of atoms) counts.set(a.chain, (counts.get(a.chain) ?? 0) + 1);
  const chains = [...counts.keys()].sort();

  chainFilterEl.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = `All chains (${chains.length})`;
  chainFilterEl.appendChild(allOption);
  for (const c of chains) {
    const option = document.createElement("option");
    option.value = c;
    option.textContent = `Chain ${c} — ${counts.get(c)!.toLocaleString()} atoms`;
    chainFilterEl.appendChild(option);
  }
  chainFilterRowEl.style.display = chains.length > 1 ? "block" : "none";
}

/** Fills the ligand/ion checklist from whatever non-water heteroatoms the
 * loaded atom records actually contain, grouped by residue name — all
 * checked in by default, matching what the initial load already built
 * (every non-water heteroatom included; see Atom.hetResName). Hidden
 * entirely when the structure has none, same as the chain filter is for
 * a single-chain structure. */
function populateHeteroFilter(atoms: Atom[]) {
  const counts = new Map<string, number>();
  for (const a of atoms) {
    if (!a.hetResName) continue;
    counts.set(a.hetResName, (counts.get(a.hetResName) ?? 0) + 1);
  }
  const resNames = [...counts.keys()].sort();

  heteroFilterListEl.innerHTML = "";
  for (const name of resNames) {
    const row = document.createElement("label");
    row.className = "void-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.resname = name;
    row.appendChild(checkbox);
    const count = counts.get(name)!;
    row.append(` ${name} — ${count.toLocaleString()} atom${count === 1 ? "" : "s"}`);
    heteroFilterListEl.appendChild(row);
  }
  heteroFilterRowEl.style.display = resNames.length > 0 ? "block" : "none";
}

/** Rebuilds the surface from `loadedAtoms`, filtered by BOTH the chain
 * filter's current selection and the ligand/ion checklist's current
 * check state together — shared by both Apply buttons so clicking either
 * one always respects the other control's current setting too, not just
 * its own. */
function applyAtomFilters() {
  if (!loadedAtoms || worker) return;
  const chain = chainFilterEl.value;
  const excludedResNames = new Set(
    [...heteroFilterListEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
      .filter((cb) => !cb.checked)
      .map((cb) => cb.dataset.resname!),
  );

  const subset = loadedAtoms.filter((a) => {
    if (chain && a.chain !== chain) return false;
    if (a.hetResName && excludedResNames.has(a.hetResName)) return false;
    return true;
  });
  if (subset.length === 0) {
    setStatus("No atoms left to build from with the current chain/ligand selection.", true);
    return;
  }

  const chainNote = chain ? ` (chain ${chain})` : "";
  const heteroNote = excludedResNames.size > 0 ? ` excl. ${[...excludedResNames].sort().join(", ")}` : "";
  const label = `${loadedAtomsSourceLabel}${chainNote}${heteroNote}`;
  const baseName = chain ? `${loadedAtomsBaseName}-chain${chain}` : loadedAtomsBaseName;
  buildSurfaceFromAtoms(subset, label, baseName);
}

applyChainFilterBtnEl.addEventListener("click", applyAtomFilters);
applyHeteroFilterBtnEl.addEventListener("click", applyAtomFilters);

enableModelDragAndDrop(
  viewerEl,
  loadFile,
  (active) => overlayEl.classList.toggle("active", active),
  (message) => setStatus(message, true),
);

fileInputEl.addEventListener("change", () => {
  const file = fileInputEl.files?.[0];
  if (file) loadFile(file);
  fileInputEl.value = ""; // so picking the same file again still fires "change"
});
browseBtnEl.addEventListener("click", () => fileInputEl.click());

/** RCSB serves both formats from a stable, well-known download path — no
 * API key/auth needed, same as visiting the URL in a browser. mmCIF is
 * the default format since RCSB now considers fixed-column PDB legacy
 * (it can't represent large structures at all past a hard atom-count
 * limit the format's columns impose); PDB is offered as a fallback for
 * anyone who specifically wants it. */
async function fetchStructureById(id: string, format: "cif" | "pdb", content: "assembly1" | "asym") {
  const cleanId = id.trim().toUpperCase();
  if (!cleanId) {
    setStatus("Enter a PDB ID to fetch (e.g. 6LU7).", true);
    return;
  }
  if (worker) {
    setStatus("Busy with another operation — wait for it to finish before fetching a new structure.", true);
    return;
  }

  // RCSB names the symmetry-expanded biological assembly differently per
  // format: "{ID}-assembly1.cif" for mmCIF, but the older "{ID}.pdb1"
  // numbered-extension convention for legacy PDB.
  const wantsAssembly = content === "assembly1";
  const fileName = wantsAssembly
    ? format === "cif" ? `${cleanId}-assembly1.cif` : `${cleanId}.pdb1`
    : `${cleanId}.${format}`;
  // loadFile sniffs the format from the extension, and ".pdb1" would not
  // match its ".pdb" check — so the File it gets is always named with a
  // plain, recognizable extension regardless of what was downloaded.
  const localName = `${cleanId}${wantsAssembly ? "-assembly1" : ""}.${format}`;

  const contentLabel = wantsAssembly ? "biological assembly" : "asymmetric unit";
  setStatus(`Fetching ${cleanId} (${contentLabel}) from RCSB…`);
  try {
    const resp = await fetch(`https://files.rcsb.org/download/${fileName}`);
    if (!resp.ok) {
      if (resp.status === 404 && wantsAssembly) {
        // Not every entry defines an assembly (and a few define it only in
        // one of the two formats) — fall back rather than dead-ending, and
        // say so, since the resulting model legitimately differs from what
        // the RCSB page shows.
        setStatus(`${cleanId} has no biological assembly file — falling back to the asymmetric unit…`);
        await fetchStructureById(cleanId, format, "asym");
        return;
      }
      setStatus(
        resp.status === 404
          ? `"${cleanId}" wasn't found on RCSB (check the ID) — or try the other format.`
          : `Fetching ${cleanId} failed (HTTP ${resp.status}).`,
        true,
      );
      return;
    }
    const text = await resp.text();
    loadFile(new File([text], localName, { type: "text/plain" }));
  } catch (err) {
    setStatus(
      `Network error fetching ${cleanId}: ${err instanceof Error ? err.message : "unknown error"}.`,
      true,
    );
  }
}

fetchIdBtnEl.addEventListener("click", () => {
  fetchStructureById(
    fetchIdInputEl.value,
    fetchFormatSelectEl.value as "cif" | "pdb",
    fetchContentSelectEl.value as "assembly1" | "asym",
  );
});
fetchIdInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") fetchIdBtnEl.click();
});

optimizeBtnEl.addEventListener("click", () => {
  if (!currentMesh || worker) return;

  const geometry = currentMesh.geometry;
  const position = geometry.attributes.position.array as Float32Array;
  const normal = geometry.attributes.normal.array as Float32Array;
  const proxyResolution = useProxyEl.checked ? Number(proxyResolutionEl.value) : undefined;

  setBusy(true);
  setStatus(proxyResolution ? `Building proxy at ${proxyResolution}³…` : "Searching orientations…");

  worker = new GeometryWorker();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      setStatus(`Searching orientations… ${Math.round(msg.fraction * 100)}%`);
      return;
    }
    if (msg.type !== "orientation-result") return;

    pushUndo("optimize");

    const up = new THREE.Vector3(...msg.up).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 0, 1));
    geometry.applyQuaternion(quat);
    placeOnBuildPlate(geometry);
    resetMeshSpin(currentMesh!);
    recolorCurrentMesh();
    updateClipPlane();
    // Rotating invalidates any previously detected cavities/highlights —
    // they were built against the pre-rotation voxel grid and would now
    // render misaligned with the (rotated) shell.
    clearVoidsList();
    refreshVisualization();

    const costLabel = msg.usedProxy ? `proxy cost (${msg.proxyTriangleCount!.toLocaleString()} tri)` : "cost";
    const optimizeStatus = `Optimized: ${costLabel} ${msg.beforeCost.toFixed(1)} → ${msg.afterCost.toFixed(1)}`;
    setStatus(optimizeStatus);
    logEvent(optimizeStatus);
    worker?.terminate();
    worker = null;
    setBusy(false);
  };

  const request: OrientationSearchRequest = {
    type: "search-orientation",
    position: position.slice(),
    normal: normal.slice(),
    criticalAngleDeg,
    proxyResolution,
  };
  worker.postMessage(request, [request.position.buffer, request.normal.buffer]);
});

/** Shared by both Detect buttons — Cavities and Tunnels come from ONE
 * flood-fill pass over the same grid (see detect-voids.ts), so running it
 * twice per kind would just repeat identical, wasted work. Only
 * `triggeredBy`'s own list/selection/highlights are touched with the
 * result, though: the OTHER kind's record, list and Fill button are left
 * exactly as they were, so clicking "Find tunnels" can't reset a cavity
 * review the user hasn't finished (or vice versa) — see
 * VoidDetectionRecord above for why splitting the one combined scan into
 * two independent records is what makes that safe. */
function runDetectVoids(triggeredBy: "cavity" | "tunnel") {
  if (!currentMesh || worker) return;

  const position = (currentMesh.geometry.attributes.position.array as Float32Array).slice();
  const resolution = Number(cavityResolutionEl.value);
  const autoSelectMax = cavityThresholdCustomEl.checked ? Number(cavityThresholdSliderEl.value) : Infinity;
  const selectedIds = triggeredBy === "cavity" ? selectedCavityIds : selectedTunnelIds;
  const listEl = triggeredBy === "cavity" ? cavitiesListEl : tunnelsListEl;

  setBusy(true);
  selectedIds.clear();
  listEl.innerHTML = "";
  updateApplyButtonState();
  clearCavityHighlights(triggeredBy);
  setStatus(`Voxelizing at ${resolution}³…`);

  worker = new GeometryWorker();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      setStatus(`Detecting ${pluralVoidWord(triggeredBy, 2)}… ${Math.round(msg.fraction * 100)}%`);
      return;
    }
    if (msg.type !== "voids-detected") return;

    const components = msg.components.filter((c) => c.kind === triggeredBy);
    const record: VoidDetectionRecord = { components, resolution, voxelSize: msg.voxelSize };
    if (triggeredBy === "cavity") {
      cavityDetection = record;
      for (const c of components) {
        if (c.voxelCount <= autoSelectMax) selectedCavityIds.add(c.id);
      }
      // Calibrate the slider's range to what was actually found — a fixed
      // arbitrary max wouldn't mean much across wildly different cavity
      // sizes, but "largest detected cavity" always gives useful resolution
      // across the full range for THIS structure.
      const largestCavity = Math.max(1, ...components.map((c) => c.voxelCount));
      cavityThresholdSliderEl.max = String(largestCavity);
      if (Number(cavityThresholdSliderEl.value) > largestCavity) cavityThresholdSliderEl.value = String(largestCavity);
      cavityThresholdValueEl.textContent = `≤ ${Number(cavityThresholdSliderEl.value).toLocaleString()} voxels`;
    } else {
      tunnelDetection = record; // selectedTunnelIds stays empty — never auto-populated, see its declaration
    }

    renderVoidGroupList(listEl, triggeredBy, selectedIds, triggeredBy === "cavity");
    updateApplyButtonState();
    // msg.components (the full combined result) is what tells a highlight
    // id apart by kind — cavityDetection/tunnelDetection only hold
    // `triggeredBy`'s own slice at this point, not necessarily both.
    buildCavityHighlights(msg.highlights, (id) => msg.components.find((c) => c.id === id)?.kind, triggeredBy);

    const count = components.length;
    const highlightedIds = new Set(msg.highlights.map((h) => h.id));
    const highlightedCount = components.filter((c) => highlightedIds.has(c.id)).length;
    const highlightNote = highlightedCount < count
      ? ` (largest ${highlightedCount} ${pluralVoidWord(triggeredBy, highlightedCount)} highlighted)`
      : "";
    const action = triggeredBy === "cavity" ? "Fill selected cavities" : "Fill selected tunnels";
    setStatus(`Found ${count} ${pluralVoidWord(triggeredBy, count)}${highlightNote} — review below, then ${action}.`);

    worker?.terminate();
    worker = null;
    setBusy(false);
  };

  const request: DetectVoidsRequest = { type: "detect-voids", position, resolution };
  worker.postMessage(request, [request.position.buffer]);
}

detectCavitiesBtnEl.addEventListener("click", () => runDetectVoids("cavity"));
detectTunnelsBtnEl.addEventListener("click", () => runDetectVoids("tunnel"));

function pluralVoidWord(kind: "cavity" | "tunnel", n: number): string {
  if (kind === "cavity") return n === 1 ? "cavity" : "cavities";
  return n === 1 ? "tunnel" : "tunnels";
}

/** The color of whichever vertex in `position` sits closest to `point` —
 * used to pick a sealed cavity's color from the chain nearest its
 * centroid, rather than a flat placeholder tone. A single nearest-vertex
 * search over the whole exterior (not an accelerated one), but this runs
 * once per SEALED CAVITY (at most a few dozen), not per vertex, so it
 * stays cheap even against a several-hundred-thousand-vertex exterior. */
/** The VERTEX NUMBER (not float-array index — divide by 3 already done)
 * in `position` closest to `point`. Used to pick a sealed cavity's color
 * (and, separately, its chain index) from whichever chain is nearest its
 * centroid, rather than a flat placeholder tone. A single nearest-vertex
 * search over the whole exterior (not an accelerated one), but this runs
 * once per SEALED CAVITY (at most a few dozen), not per vertex, so it
 * stays cheap even against a several-hundred-thousand-vertex exterior. */
function nearestVertexIndex(point: [number, number, number], position: Float32Array): number {
  const [px, py, pz] = point;
  let bestDistSq = Infinity;
  let bestVertex = 0;
  for (let v = 0; v < position.length; v += 3) {
    const dx = position[v] - px, dy = position[v + 1] - py, dz = position[v + 2] - pz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestVertex = v / 3;
    }
  }
  return bestVertex;
}

/** Shared by both Fill buttons — identical construction either way (see
 * buildSealPatchMesh, which never looks at a component's kind, only its
 * own erosion-safety property), differing only in which selection set
 * it reads and how it words status/log messages. */
function runFill(kind: "cavity" | "tunnel", selectedIds: Set<number>) {
  if (!currentMesh || worker || selectedIds.size === 0) return;

  // A component past OVERSIZED_VOID_FRACTION would concatenate a patch
  // roughly the size of the model itself onto the exterior — hard-block
  // rather than silently drop it (the way "too thin to seal" degrades),
  // since the fix here is "deselect the wrong thing you checked," not
  // "proceed with less than you asked for."
  const oversized = detectionFor(kind).components.filter((c) => selectedIds.has(c.id) && c.volumeFraction >= OVERSIZED_VOID_FRACTION);
  if (oversized.length > 0) {
    const pct = oversized.map((c) => `${Math.round(c.volumeFraction * 100)}%`).join(", ");
    setStatus(
      `Won't fill: ${oversized.length} selected ${pluralVoidWord(kind, oversized.length)} ${oversized.length === 1 ? "covers" : "cover"} ${pct} of the model's own volume — that's not a real sealed pocket, it's open space the flood-fill swept in around/between parts of the structure. Uncheck it in the list (try a higher detection resolution if you think it's wrong).`,
      true,
    );
    return;
  }

  const geometry = currentMesh.geometry;
  const position = (geometry.attributes.position.array as Float32Array).slice();
  const normal = geometry.attributes.normal.array as Float32Array;
  const triCount = position.length / 9;
  // evaluateOrientationCost is O(triangles²), on the main thread here —
  // skip it above the limit rather than freeze the tab computing a
  // "before" number nobody asked for.
  const beforeCost = triCount <= DIRECT_COST_EVAL_TRIANGLE_LIMIT
    ? evaluateOrientationCost(position, normal, new THREE.Vector3(0, 0, 1), criticalAngleDeg).cost
    : null;
  const idsToFill = [...selectedIds];

  setBusy(true);
  setStatus(
    beforeCost === null
      ? `Filling ${idsToFill.length} selected ${pluralVoidWord(kind, idsToFill.length)}…`
      : `Filling ${idsToFill.length} selected ${pluralVoidWord(kind, idsToFill.length)}… before cost ${beforeCost.toFixed(1)}`,
  );

  worker = new GeometryWorker();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      setStatus(`Filling selected ${pluralVoidWord(kind, 2)}… ${Math.round(msg.fraction * 100)}%`);
      return;
    }
    if (msg.type !== "cavity-result") return;

    pushUndo("fill");

    // Merge the new interior sealing patches onto the EXISTING exterior
    // arrays — `position`/`normal` (captured above, before the request
    // was sent) are untouched by whatever happened in the worker, so the
    // exterior survives byte-for-byte. A patch's own boundary is by
    // construction strictly inside the solid it seals, so this
    // concatenation is already a valid union — no welding needed.
    const mergedPosition = new Float32Array(position.length + msg.patchPosition.length);
    mergedPosition.set(position, 0);
    mergedPosition.set(msg.patchPosition, position.length);
    const mergedNormal = new Float32Array(normal.length + msg.patchNormal.length);
    mergedNormal.set(normal, 0);
    mergedNormal.set(msg.patchNormal, normal.length);

    // The exterior's own subunit identity is fully preserved now (its
    // vertices are untouched) — extend the color array for the new patch
    // vertices by coloring each sealed cavity to match whichever chain's
    // exterior surface its own centroid sits nearest to. That's almost
    // always the one chain that actually encloses it, since each chain
    // was voxelized/meshed independently in the first place — so a sealed
    // pocket inside chain C reads as part of chain C, rather than as an
    // unexplained 5th "part" with no identity of its own (which is what a
    // flat neutral fill used to look like once exported: a real extra
    // object in the 3MF, colored like nothing else in the model).
    if (subunitColor) {
      const oldSubunitColor = subunitColor;
      const oldChainIndex = subunitChainIndex;
      const patchVertexCount = msg.patchPosition.length / 3;
      const extendedColor = new Float32Array(oldSubunitColor.length + patchVertexCount * 3);
      extendedColor.set(oldSubunitColor, 0);
      // Extended in parallel with the color array (when there IS a real
      // chain index to extend — null for a 3MF import) so a LATER palette
      // switch can still recolor these new patch vertices correctly,
      // rather than leaving them frozen at whatever RGB the palette
      // active at fill time happened to produce.
      const extendedChainIndex = oldChainIndex ? new Int32Array(oldChainIndex.length + patchVertexCount) : null;
      if (extendedChainIndex && oldChainIndex) extendedChainIndex.set(oldChainIndex, 0);

      let vertexOffset = 0;
      for (let ci = 0; ci < msg.sealedIds.length; ci++) {
        const vertexCount = msg.sealedVertexCounts[ci];
        const component = detectionFor(kind).components.find((c) => c.id === msg.sealedIds[ci]);
        let r = 0.5, g = 0.5, b = 0.5, chainIdx = 0;
        if (component) {
          const nearest = nearestVertexIndex(component.centroid, position);
          r = oldSubunitColor[nearest * 3];
          g = oldSubunitColor[nearest * 3 + 1];
          b = oldSubunitColor[nearest * 3 + 2];
          if (oldChainIndex) chainIdx = oldChainIndex[nearest];
        }
        for (let v = 0; v < vertexCount; v++) {
          const o = oldSubunitColor.length + (vertexOffset + v) * 3;
          extendedColor[o] = r;
          extendedColor[o + 1] = g;
          extendedColor[o + 2] = b;
          if (extendedChainIndex && oldChainIndex) extendedChainIndex[oldChainIndex.length + vertexOffset + v] = chainIdx;
        }
        vertexOffset += vertexCount;
      }
      subunitColor = extendedColor;
      subunitChainIndex = extendedChainIndex;
    }

    const newGeometry = new THREE.BufferGeometry();
    newGeometry.setAttribute("position", new THREE.Float32BufferAttribute(mergedPosition, 3));
    newGeometry.setAttribute("normal", new THREE.Float32BufferAttribute(mergedNormal, 3));
    currentMesh!.geometry.dispose();
    currentMesh!.geometry = newGeometry;
    resetMeshSpin(currentMesh!);

    const afterTriCount = mergedPosition.length / 9;
    const afterCost = beforeCost !== null && afterTriCount <= DIRECT_COST_EVAL_TRIANGLE_LIMIT
      ? evaluateOrientationCost(mergedPosition, mergedNormal, new THREE.Vector3(0, 0, 1), criticalAngleDeg).cost
      : null;
    recolorCurrentMesh();
    updateClipPlane();
    refreshVisualization();
    clearVoidsList(); // mesh changed — previous detection ids no longer apply

    const patchTriCount = msg.patchPosition.length / 9;
    const skippedNote = msg.skippedCount > 0
      ? ` (${msg.skippedCount} skipped — too thin at this detection resolution to seal without risking a protrusion; try a higher detection resolution.)`
      : "";
    const sealedLabel = `Sealed ${msg.sealedCount} ${pluralVoidWord(kind, msg.sealedCount)} (${msg.filledVoxelCount.toLocaleString()} voxels, +${patchTriCount.toLocaleString()} interior triangles) — exterior surface unchanged.${skippedNote}`;
    const fillStatus = beforeCost !== null && afterCost !== null
      ? `${sealedLabel} Cost ${beforeCost.toFixed(1)} → ${afterCost.toFixed(1)}`
      : sealedLabel;
    setStatus(fillStatus);
    logEvent(fillStatus);
    worker?.terminate();
    worker = null;
    setBusy(false);
  };

  const request: CloseCavitiesRequest = {
    type: "close-cavities",
    // A SEPARATE copy from the `position` closed over above — that one
    // must stay valid and untouched for the merge once the result comes
    // back, but transferring a buffer detaches it, so the transferred
    // copy has to be distinct from the one being kept.
    position: position.slice(),
    resolution: detectionFor(kind).resolution,
    selectedCavityIds: idsToFill,
  };
  worker.postMessage(request, [request.position.buffer]);
}

applyFillCavitiesBtnEl.addEventListener("click", () => runFill("cavity", selectedCavityIds));
applyFillTunnelsBtnEl.addEventListener("click", () => runFill("tunnel", selectedTunnelIds));

// View-only preview of the export-time base-height raise (see
// downloadMeshAsSTL/downloadMeshAs3MF, which apply the same offset to a
// CLONED geometry — the live mesh's Z=0 invariant that Optimize/Fill rely
// on is never touched). Mirrors the drag-to-spin pattern: mesh.position
// moves, geometry does not. Verified live that the export itself already
// carries this offset correctly — if a slicer still drops the model back
// to Z=0 on import, that's the slicer's own auto-place-on-bed behavior
// overriding the file's coordinates, not something an STL/3MF file can
// prevent from the export side.
previewRaiseBtnEl.addEventListener("click", () => {
  if (!currentMesh) return;
  const baseHeightMm = Math.round(Math.max(0, Number(baseHeightEl.value) || 0) * 100) / 100;
  resetMeshSpin(currentMesh);
  currentMesh.position.z = baseHeightMm;
  const targets: THREE.Object3D[] = [currentMesh];
  if (comparisonMesh) targets.push(comparisonMesh);
  frameObject(targets, camera, controls);
  setStatus(
    baseHeightMm > 0
      ? `Previewing base raised to Z=${baseHeightMm.toFixed(2)}mm (view only — Export saves this; some slicers auto-drop imports back to the bed on their own).`
      : "Preview reset to Z=0.",
  );
});

exportBtnEl.addEventListener("click", async () => {
  if (!currentMesh) return;
  const baseHeightMm = Math.round(Math.max(0, Number(baseHeightEl.value) || 0) * 100) / 100;
  const filename = `${currentBaseName}-optimized.stl`;
  const saved = await downloadMeshAsSTL(currentMesh, filename, baseHeightMm);
  if (!saved) return;
  const exportStatus = baseHeightMm > 0
    ? `Exported ${filename} (base raised to Z=${baseHeightMm.toFixed(2)}mm)`
    : `Exported ${filename}`;
  setStatus(exportStatus);
  logEvent(exportStatus);
});

export3mfBtnEl.addEventListener("click", async () => {
  if (!currentMesh) return;
  const baseHeightMm = Math.round(Math.max(0, Number(baseHeightEl.value) || 0) * 100) / 100;
  const filename = `${currentBaseName}-optimized.3mf`;

  // 3MF groups triangles into separate materials/objects by color, so
  // export needs to split by PHYSICAL PART (chain) — never by the
  // on-screen overhang highlight recolorCurrentMesh blends into subunit
  // view, which would otherwise fragment every chain into an extra
  // "currently overhung" sub-object with no meaning as a printable part
  // (each chain doubling into two objects instead of staying one). Swap
  // in the pure, unblended subunit color just for the export call below,
  // then restore whatever the live view was actually showing — in a
  // finally so a cancelled/failed native save dialog can't leave the
  // live mesh stuck showing the swapped-in color.
  const liveColorAttr = currentMesh.geometry.getAttribute("color");
  if (showSubunitColorsEl.checked && subunitColor) {
    currentMesh.geometry.setAttribute("color", new THREE.BufferAttribute(subunitColor.slice(), 3));
  }
  let saved: boolean;
  try {
    saved = await downloadMeshAs3MF(currentMesh, filename, baseHeightMm);
  } finally {
    if (liveColorAttr) currentMesh.geometry.setAttribute("color", liveColorAttr);
  }
  if (!saved) return;
  const exportStatus = baseHeightMm > 0
    ? `Exported ${filename} (base raised to Z=${baseHeightMm.toFixed(2)}mm)`
    : `Exported ${filename}`;
  setStatus(exportStatus);
  logEvent(exportStatus);
});

setStatus("Drop an .stl, .pdb, .cif, or .3mf file anywhere in the viewport to load it.");
