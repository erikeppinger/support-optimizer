// Newest first. The welcome dialog shows the first few; copy the top entry's
// items into releaseBody in .github/workflows/release.yml when tagging.
export interface ReleaseNotes {
  version: string;
  items: string[];
}

export const WHATS_NEW: ReleaseNotes[] = [
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
