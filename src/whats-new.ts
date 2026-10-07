// Newest first. The welcome dialog shows the first few; copy the top entry's
// items into releaseBody in .github/workflows/release.yml when tagging.
export interface ReleaseNotes {
  version: string;
  items: string[];
}

export const WHATS_NEW: ReleaseNotes[] = [
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
