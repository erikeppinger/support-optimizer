import * as THREE from "three";
import "./style.css";
import { setupScene, frameObject, scaleBuildPlate } from "./viewer/scene-setup";
import { createAxesGizmo, disposeAxesGizmo, scaleAxesGizmo, positionAxesGizmoAtCorner } from "./viewer/axes-gizmo";
import { enableModelDragAndDrop, placeOnBuildPlate, clipPlane, loadSTLFile, buildMeshFromGeometry, COMPARISON_MESH_MATERIAL, MESH_MATERIAL } from "./mesh/load-model";
import { downloadMeshAsSTL } from "./mesh/export-stl";
import { downloadMeshAs3MF, type Export3MFResult } from "./mesh/export-3mf";
import { parse3MF, computeFlatNormals, MAX_PAINTED_COLORS } from "./mesh/threemf";
import {
  applyOverhangColors,
  applySubunitColorsWithOverhangHighlight,
  DEFAULT_CRITICAL_ANGLE_DEG,
  SAFE_COLOR_HEX,
  OVERHANG_COLOR_HEX,
  setOverhangColorMode,
} from "./geometry/overhang-cost";
import { evaluateOrientationCost, type OptimizeFor } from "./geometry/orientation-search";
import { triangleColorIndices, TOOL_CHANGE_LAYER_HEIGHT } from "./geometry/tool-changes";
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
import { cornerBarHtml, setupAboutDialog } from "./about-dialog";
import { etaTracker } from "./progress-eta";

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
    <div class="level-row">
      <div class="level-switch" role="group" aria-label="Settings shown">
        <button type="button" id="level-quick" aria-pressed="true">Quick start</button>
        <button type="button" id="level-all" aria-pressed="false">All settings</button>
      </div>${help(
        `<strong>Quick start</strong> shows the main buttons for each step, with good defaults — enough for most prints. <strong>All settings</strong> adds every control for fine-tuning: surface detail, how small a cavity can be and still be found, tunnels, the overhang angle, support previews and more.<br><br>
        Switching only shows or hides controls; it never changes a setting. Two things work a little differently in Quick start: you set the print size as the model's longest side in mm, and for a large model the best orientation is searched on a simplified copy automatically, so it doesn't take long.<br><br>
        Your choice is remembered on this computer.`,
      )}
    </div>
    <button id="cancel-btn" style="display:none">Cancel</button>
    <div class="input-row" id="undo-row">
      <button id="undo-btn" disabled>Undo last change</button>${help(
        `Takes back the last Scale, Optimize or Fill, so the model is exactly as it was before. Only one step goes back, not a full history. Chain colors come back too, if that step had changed them.`,
      )}
    </div>
    <div class="void-row">
      <input type="checkbox" id="colorblind-safe-colors" />
      <label for="colorblind-safe-colors">Colorblind-safe colors</label>${help(
        `Switches every color that carries meaning to colors that stay easy to tell apart with color blindness: the chain colors, the X/Y/Z arrows, the red/blue overhang colors and the cavity highlights.<br><br>
        A chain palette you picked yourself under Scale &amp; view is kept, and colors from an imported 3MF file stay as they are. The change shows right away and stays on for anything you load next.<br><br>
        <strong>How it works:</strong> chains use the Tol Muted palette; the other colors use Okabe–Ito.`,
      )}
    </div>

    <details id="section-load" open>
      <summary>1. Load model</summary>
      <div class="adv">
      <div class="field-label"><label for="import-resolution">PDB/mmCIF surface detail:</label>${help(
        `How fine the surface of a protein (.pdb or .cif file) is built. Higher shows more detail, such as small grooves, but takes longer to load. STL and 3MF files are loaded as they are and don't use this.<br><br>
        <strong>Auto</strong> uses less detail for very large structures so loading stays fast — a fixed high value on a structure with hundreds of thousands of atoms can take minutes. Pick a fixed value to get the same detail for every structure, or more detail than Auto would choose.<br><br>
        <strong>How it works:</strong> the molecular surface (solvent-excluded surface) is built on a grid with this many points per axis, then turned into triangles.`,
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
      </div>
      <input type="file" id="file-input" accept=".stl,.pdb,.3mf,.cif" style="display:none" />
      <button id="browse-btn">Browse for a file…</button>
      <div class="field-label"><label for="fetch-id-input">Fetch from RCSB by ID:</label>${help(
        `Type a PDB ID (for example 6LU7) to download the structure straight from the RCSB Protein Data Bank — no account needed.<br><br>
        <strong>Nothing is saved to your disk.</strong> The file is only kept in memory while the app is open. The only files this app writes are the ones you save with the Export buttons in step 5.<br><br>
        <strong>mmCIF</strong> is the current file format and works for structures of any size. <strong>PDB (legacy)</strong> is the older format: fine for small and medium structures, but very large ones may be cut short or not offered in it.<br><br>
        <strong>How it works:</strong> the file comes from <span class="formula" style="display:inline;padding:1px 4px;">files.rcsb.org/download/{ID}.{format}</span> — the same file you get by opening that address yourself.`,
      )}</div>
      <div class="input-row">
        <input type="text" id="fetch-id-input" placeholder="e.g. 6LU7" maxlength="8" style="width:90px" />
        <select id="fetch-format-select" class="adv">
          <option value="cif" selected>mmCIF</option>
          <option value="pdb">PDB (legacy)</option>
        </select>
      </div>
      <div class="adv">
      <div class="field-label"><label for="fetch-content-select">Structure content:</label>${help(
        `<strong>Biological assembly</strong> is the complete molecule as it works in nature — what the RCSB web page shows by default, and usually what you want to print. Many entries are stored as one copy of a repeating piece, even when the real protein is made of two, three or more copies; this option downloads the complete version. Copies of the same chain are named A, A-2, A-3, so each still gets its own color.<br><br>
        <strong>Asymmetric unit</strong> is the file exactly as the researchers deposited it, without the copies added. Pick it if that is what you want, or if an entry has no assembly.<br><br>
        If a structure looks smaller or is missing subunits compared to the RCSB page, this is why: the page shows Assembly 1, while a plain download gives the asymmetric unit.<br><br>
        <strong>How it works:</strong> the assembly is downloaded as <span class="formula" style="display:inline;padding:1px 4px;">{ID}-assembly1.cif</span> (or <span class="formula" style="display:inline;padding:1px 4px;">{ID}.pdb1</span>), the asymmetric unit as <span class="formula" style="display:inline;padding:1px 4px;">{ID}.cif</span>.`,
      )}</div>
      <select id="fetch-content-select">
        <option value="assembly1" selected>Biological assembly (as shown on RCSB)</option>
        <option value="asym">Asymmetric unit (deposited file)</option>
      </select>
      </div>
      <button id="fetch-id-btn">Fetch</button>
      <div id="chain-filter-row" class="adv" style="display:none">
        <div class="field-label"><label for="chain-filter">Build surface from:</label>${help(
          `Builds the model from one chain (subunit) only, instead of all of them — to print one piece of a large complex, or to check how one subunit prints on its own. Choose "All chains" and Apply again to get the full structure back.<br><br>
          Nothing is downloaded again, so it works the same for a fetched structure and a file you opened. Any Fill or Optimize you did is lost, since the surface is built anew.`,
        )}</div>
        <div class="input-row">
          <select id="chain-filter"></select>
          <button id="apply-chain-filter-btn">Apply</button>
        </div>
      </div>
      <div id="hetero-filter-row" class="adv" style="display:none">
        <div class="field-label">Ligands &amp; ions found:</div>${help(
          `Everything in the file that isn't part of the protein chains: ligands, metal ions, and leftovers from the experiment such as salts, glycerol or PEG. All are included by default. Water is never included — each water molecule would print as its own tiny speck.<br><br>
          Uncheck what you don't want in the print, then click Apply. Nothing is downloaded again, and the chain choice above is kept.<br><br>
          A ligand bound in a pocket of the protein usually prints fine either way. This matters most for a loose ion or additive sitting apart from the protein: it prints as a tiny separate piece that the slicer then tries to hold up with support. If a print has small floating pieces, look here.`,
        )}
        <div id="hetero-filter-list"></div>
        <button id="apply-hetero-filter-btn">Apply</button>
      </div>
    </details>

    <details id="section-view">
      <summary>2. Scale &amp; view</summary>
      <div id="scale-current-size"></div>
      <div class="adv">
      <div class="field-label"><label for="scale-mode">Scale model:</label>${help(
        `Makes the model bigger or smaller. It always scales evenly in all directions, so the proportions never change.<br><br>
        <strong>By percentage:</strong> 200% makes it twice as large, 50% half as large.<br>
        <strong>To target size:</strong> type the size you want in mm, for the longest side or for X, Y or Z.`,
      )}</div>
      <select id="scale-mode">
        <option value="percent">By percentage</option>
        <option value="absolute">To target size (mm)</option>
      </select>
      </div>
      <div id="scale-percent-row" class="input-row">
        <input type="number" id="scale-percent" min="0.01" step="0.01" value="100.00" />
        <span>%</span>
      </div>
      <div class="field-label quick-only"><label for="scale-target">Print size, longest side (mm):</label></div>
      <div id="scale-absolute-row" class="input-row" style="display:none">
        <select id="scale-axis" class="adv">
          <option value="largest" selected>Largest dim</option>
          <option value="x">X</option>
          <option value="y">Y</option>
          <option value="z">Z</option>
        </select>
        <input type="number" id="scale-target" min="0.01" step="0.01" placeholder="target mm" />
      </div>
      <button id="apply-scale-btn" disabled>Apply scale</button>
      <div class="slider-label"><label for="cross-section">Cross-section: <span id="cross-section-value">off</span></label>${help(
        `Cuts the model open on screen so you can look inside it — for example at its cavities. It only changes the view, never the model. 0% shows the whole model; higher values cut more of it away, along its X axis.<br><br>
        Double-click the slider, or click Reset, to switch it off.`,
      )}</div>
      <div class="input-row">
        <input type="range" id="cross-section" min="0" max="100" step="1" value="0" />
        <button type="button" id="cross-section-reset" title="Reset cross-section to off">Reset</button>
      </div>
      <div class="void-row">
        <input type="checkbox" id="show-subunit-colors" disabled />
        <label for="show-subunit-colors">Show subunit colors</label>${help(
          `Gives each chain (subunit) of a protein its own color, so you can see where one ends and the next begins. These are the colors the 3MF export prints, one per extruder.<br><br>
          Surfaces that need support still show in red in this view. When Fill closes a cavity, the filling takes the color of the nearest chain.<br><br>
          <strong>How it works:</strong> each chain is built as its own surface, so the borders between colors follow the real chain borders exactly.`,
        )}
      </div>
      <div class="input-row adv">
        <label for="chain-palette-select" style="white-space:nowrap">Palette:</label>${help(
          `The set of colors the chains use. Switching only changes the colors, right away.<br><br>
          <strong>Okabe&ndash;Ito</strong> and <strong>Tol Muted</strong> are designed to stay easy to tell apart with color blindness. <strong>Viridis</strong> is too, and stays readable in grayscale, though it is really meant for values in an order rather than separate groups.<br><br>
          Each palette has 7 to 12 colors. A structure with more chains than that repeats colors.`,
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
      <div class="adv">
      <div class="field-label"><label for="cavity-resolution">Void detection resolution:</label>${help(
        `How small a cavity can be and still be found. Higher finds smaller and narrower cavities, and the filling follows their shape more closely, but it takes longer. Medium suits most prints.<br><br>
        Small cavities inside a single chain are found at any setting (see Find cavities).<br><br>
        It also matters for large prints. A cavity joined to the outside only by a very narrow slit counts as closed, and filling it closes the slit as well. At Medium, slits narrower than about 1/64 of the model's longest side count as closed; at High, 1/128. So for a large print, a higher setting keeps more of the surface's fine detail open.<br><br>
        <strong>How it works:</strong> the model is divided into a grid of small cubes (voxels), this many along its longest side, and the empty ones are checked. Cavities and Tunnels use the same grid.`,
      )}</div>
      <select id="cavity-resolution">
        <option value="32">Low (32&sup3;)</option>
        <option value="64" selected>Medium (64&sup3;)</option>
        <option value="128">High (128&sup3;)</option>
        <option value="192">Very high (192&sup3;)</option>
        <option value="256">Extreme (256&sup3;)</option>
        <option value="320">Maximum (320&sup3;) — slow</option>
      </select>
      </div>
      <div class="void-group">
        <div class="void-group-title">Cavities <span class="void-group-sub">— empty spaces closed off inside the model</span></div>
        <div class="void-row adv">
          <input type="checkbox" id="cavity-threshold-custom" />
          <label for="cavity-threshold-custom">Custom auto-select size limit (default: select all cavities)</label>${help(
            `Normally every cavity found is checked for filling. Turn this on to check only cavities up to the size you set — for example to leave large cavities open. You can still check or uncheck each cavity in the list yourself.`,
          )}
        </div>
        <div class="input-row adv" id="cavity-threshold-row" style="display:none">
          <input type="range" id="cavity-threshold-slider" min="1" max="10000" step="1" value="1000" />
          <span id="cavity-threshold-value">≤ 1,000 voxels</span>
        </div>
        <button id="detect-cavities-btn" disabled>Find cavities</button>${help(
          `Finds <strong>cavities</strong>: empty spaces closed off on all sides inside the model, with no opening to the outside. You can't see them from outside, but the slicer prints each one as a hollow space with walls of its own, and any support it puts inside can never be removed. Fill can make them solid.<br><br>
          This includes empty space trapped between two chains that touch. Grooves and pockets open to the surface are not cavities and are never listed — they are part of the model's shape.<br><br>
          Very small cavities inside a single chain are found too, whatever the detection setting. Large structures can have dozens to hundreds of cavities; the list shows the 20 largest and counts the rest below them, and those are filled too.<br><br>
          Find cavities and Find tunnels each keep their own list — running one never resets the other.<br><br>
          <strong>How it works:</strong> empty grid cubes that can be reached from outside are marked; the empty cubes that can't be reached are cavities. A cavity inside one chain also has its own closed inner surface in the mesh, which is how cavities smaller than a grid cube are found (down to an eighth of one).`,
        )}
        <div class="void-row adv">
          <input type="checkbox" id="show-void-highlights" checked />
          <label for="show-void-highlights">Highlight on model (<span id="highlight-include-name">magenta</span> = will fill, orange = excluded)</label>${help(
            `Shows the cavities and tunnels inside the model: magenta ones will be filled (green with colorblind-safe colors on), orange ones are left as they are. The model turns see-through so you can see them. The 20 largest of each are shown.`,
          )}
        </div>
        <div id="cavities-list"></div>
        <button id="apply-fill-cavities-btn" disabled>Fill selected cavities</button>${help(
          `<strong>Fill selected cavities</strong> makes the selected cavities solid, so the slicer doesn't print hollow spaces inside your model. The outside of the model stays exactly as it is.<br><br>
          A cavity inside a single chain is simply closed up. A cavity between two chains gets a small filler piece that reaches a little into the walls around it, so the slicer joins it to the model instead of printing it as a loose plug. Thin empty gaps the filler would trap next to the outer wall are filled too. A very small cavity right under the outer surface has nothing to hold on to and is skipped.<br><br>
          <strong>How it works:</strong> cavities inside a chain are closed by removing their inner surface. A filler piece overlaps about 2 grid cubes into the solid around it, and a grid six times finer checks for gaps trapped around each one.`,
        )}
      </div>
      <div class="void-group adv">
        <div class="void-group-title">Tunnels <span class="void-group-sub">— channels open to the outside</span></div>
        <button id="detect-tunnels-btn" disabled>Find tunnels</button>${help(
          `Finds <strong>tunnels</strong>: narrow channels through the model that are open to the outside — most often along the seam where two chains meet but don't quite close. Filling one changes the model's shape more than filling a cavity, so none are selected; fill only the ones you don't want in the print.<br><br>
          Find tunnels only updates the tunnel list; your cavity list stays as it is.<br><br>
          <strong>How it works:</strong> a tunnel is empty grid cubes that can be reached from outside but lie within the model's outline.`,
        )}
        <div id="tunnels-list"></div>
        <button id="apply-fill-tunnels-btn" disabled>Fill selected tunnels</button>${help(
          `Fills each selected tunnel; the outside of the model stays as it is. Unlike a cavity filler, a tunnel filler keeps a small gap to the tunnel's walls, so the slicer may print it as a separate plug inside the channel.<br><br>
          A tunnel narrower than about 3 grid cubes is skipped; raise the detection setting and find tunnels again to fill it. Nothing is selected at first — check the ones you want filled.`,
        )}
      </div>
    </details>

    <details id="section-optimize">
      <summary>4. Optimize orientation</summary>
      <div class="slider-label adv"><label for="critical-angle">Critical overhang angle: <span id="critical-angle-value"></span>&deg;</label>${help(
        `How steep an overhang your printer can print without support. A surface that leans further than this from vertical needs support and shows in red. 0&deg; is a vertical wall; 90&deg; is a flat ceiling facing down. Most FDM printers manage about 45&deg;, resin printers often more.<br><br>
        Everything in this step uses this angle: what Optimize minimizes, and where the support preview starts. Changing it recolors the model but never changes its shape.<br><br>
        <strong>Lower angles take longer.</strong> More surfaces count as overhangs, and each one has to be checked — on a test sphere, 30&deg; took about twice as long as 45&deg;, and 15&deg; about three times as long.<br><br>
        <strong>How it works:</strong> each triangle's lean is <span class="formula" style="display:inline;padding:1px 4px;">asin(&minus;normal Z) &times; 180/&pi;</span>.`,
      )}</div>
      <input type="range" id="critical-angle" class="adv" min="0" max="90" step="1" value="${DEFAULT_CRITICAL_ANGLE_DEG}" />
      <div id="overhang-legend" class="void-row-readonly"></div>
      <div id="proxy-advisory" class="void-row-readonly adv" style="display:none">This model is detailed, so Optimize may take a while. Searching on a simplified copy (below) speeds it up; your model itself isn't simplified.</div>
      <div class="void-row adv">
        <input type="checkbox" id="use-proxy" />
        <label for="use-proxy">Search on a simplified copy (faster)</label>${help(
          `Makes Optimize much faster on detailed models by searching for the best orientation on a simplified copy. The result is then applied to your full model, which isn't simplified — only the search uses the copy. Quick start does this automatically for large models.<br><br>
          Coarse is fastest; Fine is closest to your model.<br><br>
          <strong>How it works:</strong> the search time grows with the square of the number of triangles: a 200,000-triangle model would take about 40 billion steps for each of the ~38 directions tried. The copy is rebuilt from a grid of 24–48 cubes per side. The result is only a rotation, so applying it to the full model loses nothing.`,
        )}
      </div>
      <select id="proxy-resolution" class="adv">
        <option value="24">Coarse (24&sup3;)</option>
        <option value="32" selected>Medium (32&sup3;)</option>
        <option value="48">Fine (48&sup3;)</option>
      </select>
      <div class="multi-color-only">
      <div class="field-label"><label for="optimize-for">Optimize for</label>${help(
        `What Optimize turns the model for, when it prints in several colors (one per chain, or a colored 3MF).<br><br>
        <strong>Least support</strong> turns it so it needs the least support material. <strong>Fewest tool changes</strong> turns it so the printer switches colors as rarely as possible, which saves time and purged filament; support only decides between otherwise equal choices. <strong>Balanced</strong> weighs both equally.<br><br>
        Every layer prints each color it contains, so color changes add up layer by layer, and the orientation matters a lot: on test models the count differed by up to about three times between orientations. What a change costs depends on the printer. A tool changer like the Prusa XL swaps toolheads in seconds; a single-nozzle system like Bambu's AMS or Prusa's MMU3 unloads, loads and purges filament every time. On a four-chain test model sliced for a Bambu A1, the orientation with fewest changes cut them from 1,147 to 603, the purged filament from 392 g to 261 g, and the print time by 14 hours.<br><br>
        With a single color there is nothing to change, and Optimize goes for least support.<br><br>
        <strong>How it works:</strong> changes are counted for 0.2 mm layers: a layer with k colors needs k &minus; 1 changes, one more when it doesn't contain the color the layer below ended on. On 12 test orientations of four models, this matched PrusaSlicer's count within 3%, and OrcaSlicer and Bambu Studio counted the same as PrusaSlicer. For Balanced, both are scaled to the range seen across the orientations tried, then added.`,
      )}</div>
      <select id="optimize-for">
        <option value="support" selected>Least support</option>
        <option value="balanced">Balanced: support and tool changes</option>
        <option value="tool-changes">Fewest tool changes</option>
      </select>
      </div>
      <button id="optimize-btn" disabled>Optimize orientation</button>${help(
        `Turns the model so it needs as little support as possible — or, for a print in several colors, as few color changes as you chose above. Undo takes it back.<br><br>
        You can rotate the view while it runs; that doesn't affect the result. Rotating with the mouse only ever changes the view, never the model, so it doesn't change what you export either.<br><br>
        <strong>How it works:</strong> about 38 directions are tried — 32 spread evenly over a sphere and turned randomly on each run, plus the 6 axis directions — then the best few are refined and the best one wins. Each is scored by<br>
        <span class="formula">cost = &Sigma; over overhang triangles of
area &times; (drop height to the plate,
or to whatever surface is below it first)</span>
        minus a bonus for contact with the plate, so a stable, flat rest beats balancing on a corner.`,
      )}
      <div class="void-row adv">
        <input type="checkbox" id="show-support-paths" />
        <label for="show-support-paths">Show support paths</label>${help(
          `Draws a rough picture of where supports would go, to compare orientations. It isn't what your slicer will make, and it is never exported.<br><br>
          <strong>Organic</strong> — branches that join into fewer trunks toward the plate, like tree supports. Branches never lean further than the overhang angle, since they have to be printable too.<br>
          <strong>Snug</strong> — straight columns that follow the overhang's shape.<br>
          <strong>Grid</strong> — straight columns on a regular grid.<br><br>
          It runs in the background, so the app stays responsive; it is skipped for models above 3,000,000 triangles.<br><br>
          <strong>How it works:</strong> overhanging triangles are grouped into starting points, and each is traced straight down to the plate or to the part of the model below it.`,
        )}
      </div>
      <div class="input-row adv">
        <label for="support-style-select" style="white-space:nowrap">Style:</label>
        <select id="support-style-select">
          <option value="organic" selected>Organic (tree-like)</option>
          <option value="snug">Snug (straight, follows shape)</option>
          <option value="grid">Grid (straight, regular lattice)</option>
        </select>
      </div>
      <div class="void-row adv">
        <input type="checkbox" id="show-comparison" />
        <label for="show-comparison">Compare to start model (side-by-side)</label>${help(
          `Shows the model as you loaded it next to the current one, so you can see what changed. That includes everything since loading — scaling, filling and orientation — not only the last step.<br><br>
          Undo doesn't change this copy; loading a new model resets it.`,
        )}
      </div>
    </details>

    <details id="section-export">
      <summary>5. Export</summary>
      <div class="void-row-readonly">Exports use the model's orientation from Optimize. Rotating the view with the mouse doesn't change what is saved.</div>
      <div class="field-label adv"><label for="base-height">Raise base to Z (mm) — for breakaway support/interface layers</label>${help(
        `Raises the exported model so its lowest point sits at this height instead of on the plate — for printing a separate breakaway support or interface layer below it. Only the saved file is raised; the model on screen stays on the plate.<br><br>
        Many slicers drop a loaded model back onto the plate anyway; check your slicer if the height doesn't stick.`,
      )}</div>
      <div class="input-row adv">
        <input type="number" id="base-height" min="0" step="0.01" value="0.00" />
        <button id="preview-raise-btn">Preview</button>
      </div>
      <button id="export-btn" disabled>Export STL</button>${help(
        `Saves the model as an STL file, which any slicer can open. STL has no colors; for a print in several colors, use Export 3MF.<br><br>
        The desktop app asks where to save it. In the browser, the file goes to your usual downloads folder.<br><br>
        The file is saved as one closed solid, so the slicer doesn't report open edges.<br><br>
        <strong>How it works:</strong> triangles are joined at their shared corners (welded) in the saved copy; the model on screen stays as it is.`,
      )}
      <button id="export-3mf-btn" disabled>Export 3MF (multi-material)</button>${help(
        `Saves the model with its colors, for printing in several colors. Each color goes to its own extruder: the first color to extruder 1, the second to extruder 2, and so on — you can change that in the slicer. The slicer opens it as one part, with no open edges.<br><br>
        The colors are what you see: one per chain when subunit colors show, or the two overhang colors when those show. A 3MF you imported keeps its own colors.<br><br>
        Up to ${MAX_PAINTED_COLORS} colors work this way. With more, each color is saved as a separate part, and the slicer reports open edges where they meet.<br><br>
        <strong>In OrcaSlicer</strong>, set up at least as many filaments as the model has colors <em>before</em> opening the file — colors beyond the number of filaments are lost when it loads. <strong>Bambu Studio</strong> says the file has an invalid configuration and loads only the geometry; the colors still come through.<br><br>
        <strong>How it works:</strong> the colors are painted onto one mesh, the same way the slicers' own multi-material paint tools do it.`,
      )}
      <div class="void-row adv">
        <input type="checkbox" id="color-through" checked />
        <label for="color-through">Color each chain all the way through (PrusaSlicer)</label>${help(
          `Keeps each chain one color all the way through, inside and out. Without it, PrusaSlicer with Prusa's profiles for the MK4/MK4S, Core One and XL prints the inside of thick chains in another color, with extra walls around it — in the sliced preview, chains whose inside doesn't match their outside. On a four-chain test model sliced for the XL, this cut the printed walls by more than a third.<br><br>
          It applies only to this model, and you can still change it in PrusaSlicer. Other slicers ignore it: OrcaSlicer colors chains through already, and in Bambu Studio, if a chain's inside comes out in another color, look for the setting named below.<br><br>
          <strong>How it works:</strong> the file sets PrusaSlicer's <strong>Maximum width of a segmented region</strong> (Print Settings → Multiple Extruders → Advanced) to 0 for this model. Prusa's profiles set it to 5 mm; deeper than that, a chain's inside becomes a separate region. Only for colored exports of up to ${MAX_PAINTED_COLORS} colors.`,
        )}
      </div>
    </details>

    <details id="section-log">
      <summary>Session log</summary>
      <div id="session-log"></div>
    </details>
  </div>
  ${cornerBarHtml(__APP_VERSION__)}
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
const optimizeForEl = document.querySelector<HTMLSelectElement>("#optimize-for")!;
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
const levelQuickEl = document.querySelector<HTMLButtonElement>("#level-quick")!;
const levelAllEl = document.querySelector<HTMLButtonElement>("#level-all")!;

/** Quick start hides fine-tuning controls (class "adv"); All settings shows
 * every control. Hiding never changes a value. Remembered per browser. */
type UiLevel = "quick" | "all";
const UI_LEVEL_KEY = "support-optimizer-ui-level";
function storedUiLevel(): UiLevel | null {
  try {
    const v = localStorage.getItem(UI_LEVEL_KEY);
    return v === "quick" || v === "all" ? v : null;
  } catch {
    return null;
  }
}
function isQuickLevel(): boolean {
  return controlsPanelEl.classList.contains("quick");
}
function setUiLevel(level: UiLevel) {
  controlsPanelEl.classList.toggle("quick", level === "quick");
  levelQuickEl.setAttribute("aria-pressed", String(level === "quick"));
  levelAllEl.setAttribute("aria-pressed", String(level === "all"));
  updateScaleRows();
  try {
    localStorage.setItem(UI_LEVEL_KEY, level);
  } catch {
    // Not remembered; the choice still applies for this session.
  }
}
levelQuickEl.addEventListener("click", () => setUiLevel("quick"));
levelAllEl.addEventListener("click", () => setUiLevel("all"));

/** "Optimize for" only matters with 2+ colors; Quick start hides it otherwise. */
function updateColorCountClass() {
  controlsPanelEl.classList.toggle("single-color", !(subunitColor && triangleColorIndices(subunitColor)));
}
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
const colorThroughEl = document.querySelector<HTMLInputElement>("#color-through")!;

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
  // In Quick start, a step's help points to the settings it hides.
  const moreNote = isQuickLevel() && btn.closest("details")
    ? `<p class="help-more">More options for this step are under <strong>All settings</strong>, at the top of the panel.</p>`
    : "";
  helpPanelContentEl.innerHTML = (helpContent.get(key) ?? "") + moreNote;
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
  document.querySelector("#highlight-include-name")!.textContent = safe ? "green" : "magenta";

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
      ? `+ ${hidden.length} more small ${pluralVoidWord(kind, hidden.length)} (all included by default)`
      : `+ ${hidden.length} more small ${pluralVoidWord(kind, hidden.length)} (not listed — none pre-selected)`;
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

/** Quick start always scales by print size (longest side); the scale-mode
 * and axis choices from All settings are kept for when it's shown again. */
function scaleModeInUse(): { mode: string; axis: string } {
  return isQuickLevel() ? { mode: "absolute", axis: "largest" } : { mode: scaleModeEl.value, axis: scaleAxisEl.value };
}
function updateScaleRows() {
  const isPercent = scaleModeInUse().mode === "percent";
  scalePercentRowEl.style.display = isPercent ? "flex" : "none";
  scaleAbsoluteRowEl.style.display = isPercent ? "none" : "flex";
}
scaleModeEl.addEventListener("change", updateScaleRows);

applyScaleBtnEl.addEventListener("click", () => {
  if (!currentMesh || busy) return;

  const geometry = currentMesh.geometry;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const dx = box.max.x - box.min.x, dy = box.max.y - box.min.y, dz = box.max.z - box.min.z;

  let factor: number;
  const { mode, axis } = scaleModeInUse();
  if (mode === "percent") {
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
  updateColorCountClass();
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

  // The first 15% is file parsing, which runs faster than the surface build.
  const eta = etaTracker(0.15);
  worker = new GeometryWorker();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      setStatus(`Building surface from ${atomCount ? atomCount.toLocaleString() + " atoms" : atomCountHint}… ${Math.round(msg.fraction * 100)}%${eta(msg.fraction)}`);
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
  // Quick start hides the proxy checkbox and uses the proxy wherever the
  // advisory would recommend it.
  const autoProxy = isQuickLevel() && position.length / 9 > DIRECT_COST_EVAL_TRIANGLE_LIMIT;
  const proxyResolution = useProxyEl.checked || autoProxy ? Number(proxyResolutionEl.value) : undefined;
  // Tool changes come from the colors the 3MF export paints (one per chain).
  const colors = subunitColor ? triangleColorIndices(subunitColor) : null;
  const optimizeFor = optimizeForEl.value as OptimizeFor;

  setBusy(true);
  setStatus(proxyResolution ? `Building a simplified copy (${proxyResolution}³)…` : "Searching orientations…");

  // With the proxy, the first 20% is building it, not searching.
  const eta = etaTracker(proxyResolution ? 0.2 : 0.1);
  worker = new GeometryWorker();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      setStatus(`Searching orientations… ${Math.round(msg.fraction * 100)}%${eta(msg.fraction)}`);
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

    const costLabel = msg.usedProxy ? `support cost on simplified copy (${msg.proxyTriangleCount!.toLocaleString()} triangles)` : "cost";
    const toolChangeNote = msg.beforeToolChanges !== null && msg.afterToolChanges !== null
      ? `, tool changes ≈ ${msg.beforeToolChanges.toLocaleString()} → ${msg.afterToolChanges.toLocaleString()} (${TOOL_CHANGE_LAYER_HEIGHT} mm layers)`
      : optimizeFor !== "support" ? " (single color, so optimized for least support)" : "";
    const optimizeStatus = `Optimized: ${costLabel} ${msg.beforeCost.toFixed(1)} → ${msg.afterCost.toFixed(1)}${toolChangeNote}`;
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
    triColor: colors?.index,
    optimizeFor,
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

  const eta = etaTracker();
  worker = new GeometryWorker();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      setStatus(`Detecting ${pluralVoidWord(triggeredBy, 2)}… ${Math.round(msg.fraction * 100)}%${eta(msg.fraction)}`);
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
  let position = (geometry.attributes.position.array as Float32Array).slice();
  let normal = geometry.attributes.normal.array as Float32Array;
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

  const eta = etaTracker();
  worker = new GeometryWorker();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      setStatus(`Filling selected ${pluralVoidWord(kind, 2)}… ${Math.round(msg.fraction * 100)}%${eta(msg.fraction)}`);
      return;
    }
    if (msg.type !== "cavity-result") return;

    pushUndo("fill");

    // Cavities enclosed by one chain are filled by deleting their inner
    // surface (see the worker); drop those triangles from every per-vertex
    // array first. Everything else stays byte-for-byte.
    if (msg.removedTriangles.length > 0) {
      const removed = new Uint8Array(position.length / 9);
      for (const t of msg.removedTriangles) removed[t] = 1;
      const keepVertex = (v: number) => removed[Math.floor(v / 3)] === 0;
      const keepFloats = (a: Float32Array, stride: number) => {
        const out = new Float32Array(a.length - msg.removedTriangles.length * 3 * stride);
        let o = 0;
        for (let v = 0; v < a.length / stride; v++) {
          if (!keepVertex(v)) continue;
          for (let k = 0; k < stride; k++) out[o++] = a[v * stride + k];
        }
        return out;
      };
      position = keepFloats(position, 3);
      normal = keepFloats(normal, 3);
      if (subunitColor) subunitColor = keepFloats(subunitColor, 3);
      if (subunitChainIndex) subunitChainIndex = subunitChainIndex.filter((_, v) => keepVertex(v));
    }

    // Merge the new interior sealing patches onto the EXISTING exterior
    // arrays — `position`/`normal` (captured above, before the request
    // was sent) are otherwise untouched by whatever happened in the
    // worker. A patch's own boundary is by construction strictly inside
    // the solid it seals, so this concatenation is already a valid union —
    // no welding needed.
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
        const centroid: [number, number, number] = [msg.sealedCentroids[ci * 3], msg.sealedCentroids[ci * 3 + 1], msg.sealedCentroids[ci * 3 + 2]];
        const nearest = nearestVertexIndex(centroid, position);
        const r = oldSubunitColor[nearest * 3];
        const g = oldSubunitColor[nearest * 3 + 1];
        const b = oldSubunitColor[nearest * 3 + 2];
        const chainIdx = oldChainIndex ? oldChainIndex[nearest] : 0;
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
      ? kind === "cavity"
        ? ` (${msg.skippedCount} skipped — pockets of a few voxels at most, right at the outer surface, with no wall to anchor a seal to.)`
        : ` (${msg.skippedCount} skipped — too thin at this detection resolution to seal without risking a protrusion; try a higher detection resolution.)`
      : "";
    const sealedLabel = `Sealed ${msg.sealedCount} ${pluralVoidWord(kind, msg.sealedCount)} (${msg.filledVoxelCount.toLocaleString()} voxels, +${patchTriCount.toLocaleString()} interior triangles${msg.removedTriangles.length > 0 ? `, ${(msg.removedTriangles.length).toLocaleString()} inner-surface triangles removed` : ""}) — exterior surface unchanged.${msg.closedOffCount > 0 ? ` Also filled ${msg.closedOffCount} ${msg.closedOffCount === 1 ? "pocket" : "pockets"} the seals had closed off.` : ""}${skippedNote}`;
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
  let result: Export3MFResult;
  try {
    result = await downloadMeshAs3MF(currentMesh, filename, baseHeightMm, colorThroughEl.checked);
  } finally {
    if (liveColorAttr) currentMesh.geometry.setAttribute("color", liveColorAttr);
  }
  if (!result.saved) return;
  const raised = baseHeightMm > 0 ? ` (base raised to Z=${baseHeightMm.toFixed(2)}mm)` : "";
  const how = result.mode === "painted"
    ? result.colorCount > 1
      ? ` — one closed mesh, ${result.colorCount} colors painted onto extruders 1–${result.colorCount}${colorThroughEl.checked ? ", each colored all the way through" : ""}`
      : ""
    : ` — more than ${MAX_PAINTED_COLORS} colors, so each color is its own part; slicers will report open edges where parts meet`;
  const exportStatus = `Exported ${filename}${raised}${how}`;
  setStatus(exportStatus);
  logEvent(exportStatus);
});

// Last, once every control's listeners are wired: the level switch drives
// some of them (the scale mode), and the welcome dialog offers the choice.
setUiLevel(storedUiLevel() ?? "quick");
setupAboutDialog(__APP_VERSION__, { get: () => (isQuickLevel() ? "quick" : "all"), set: setUiLevel });

setStatus("Drop an .stl, .pdb, .cif, or .3mf file anywhere in the viewport to load it.");
