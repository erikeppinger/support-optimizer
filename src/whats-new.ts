// Newest first. The welcome dialog shows the first few; copy the top entry's
// items into RELEASE_BODY in .github/workflows/release.yml when tagging.
export interface ReleaseNotes {
  version: string;
  items: string[];
}

export const WHATS_NEW: ReleaseNotes[] = [
  {
    version: "1.1.0",
    items: [
      "New: <strong>Quick start</strong> and <strong>All settings</strong>. Quick start shows each step's main buttons with good defaults; All settings shows every control. The welcome dialog asks which you prefer, and a switch at the top of the panel changes it any time.",
      "Optimize can now also cut down color changes for prints in several colors. Least support turns the model so it needs the least support material; Fewest tool changes turns it so the printer switches colors less often, which saves time and purged filament; Balanced weighs both. The status line shows how many changes the print needs before and after.",
      "Find cavities now also finds very small empty spaces sealed inside a single chain. They are closed on all sides, so you can't see them from outside, but the slicer would print each one as a tiny hollow space. Fill makes them solid. Grooves and pockets that are open to the surface are never touched.",
      "Fill leaves far fewer hollow spaces inside the print. Filling a cavity close to the outer wall could trap a thin empty gap between the fill and the wall; Fill now finds those and fills them too. The \"Close gaps narrower than the nozzle\" export option is removed, because it trapped new empty spaces instead of closing gaps.",
    ],
  },
  {
    version: "1.0.12",
    items: [
      "Filled cavities now become part of the subunit around them. A cavity inside one chain is filled exactly, by removing its inner skin; a pocket between chains gets a seal that reaches slightly into the surrounding walls. Either way the slicer prints one continuous solid instead of a loose plug inside its pocket.",
      "Find cavities lists only genuinely empty space. A chain's own inside, and the overlap between neighboring chains, were showing up as cavities and getting an extra inner skin when filled.",
      "3MF export has a new option, on by default: color each chain all the way through in PrusaSlicer. Prusa's current profiles for the MK4/MK4S, Core One and XL carry painted colors only 5 mm into the model, so the inside of a chain came out in another extruder's color, with extra walls around it. OrcaSlicer's profiles keep that limit off.",
      "Filled cavities print as solid material without tiny leftover pockets: seals now reach the real cavity walls, and a new 3MF export option, on by default, has PrusaSlicer close gaps narrower than the nozzle.",
    ],
  },
  {
    version: "1.0.11",
    items: [
      "Long steps — building a surface, finding or filling cavities, searching orientations — now show roughly how much time is left in the status line.",
      "The help for the critical overhang angle now explains that lower angles take longer to compute.",
    ],
  },
  {
    version: "1.0.10",
    items: [
      "3MF export keeps your model in one piece: instead of one part per color, it saves a single closed mesh with each color painted onto its own extruder, the way PrusaSlicer, Bambu Studio and OrcaSlicer's own paint tools do. Slicers no longer report open edges, and a ChimeraX-painted model keeps its painting through optimization.",
    ],
  },
  {
    version: "1.0.9",
    items: [
      "This welcome dialog, with a quick start and links to the manual, the desktop downloads and the source code. Reopen it any time from the ⓘ button in the lower-right corner.",
    ],
  },
  {
    version: "1.0.8",
    items: [
      "Help texts for filling cavities and tunnels now describe how sealing actually works.",
    ],
  },
  {
    version: "1.0.7",
    items: [
      "Colorblind-safe colors for chains, axes, overhang shading and cavity highlights.",
      "3MF files exported from ChimeraX or painted in a slicer keep their colors when loaded.",
      "Choose which ligands and ions go into the surface after loading a PDB/mmCIF file.",
      "Cavity sealing now seals thin cavities it used to skip.",
    ],
  },
];
