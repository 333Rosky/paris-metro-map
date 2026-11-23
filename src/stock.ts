// Rolling stock drawn as a real mesh when a train is opened (see train-mesh.ts).
// Kept apart from the mesh code so that the page knows each line's stock and
// train length without downloading three.js.
//
// The feed names no trainset or stock type: a train gets the stock that runs
// most of its line's service (lines in transition: see the notes by line).

/** A band painted along the whole side, between two heights above the rail (m). */
export interface Band {
  z0: number;
  z1: number;
  color: string;
}

export interface Livery {
  body: string;
  /** Lower body, from the foot of the side up to `skirtTop`: bottom and top colours. */
  skirt: [string, string];
  skirtTop: number;
  bands: Band[];
  /** Behind the windows, from the first to the last of a bay (a continuous dark strip), if any. */
  windowStrip?: string;
  door: string;
  doorFrame: string;
  /** Vertical line where the two door leaves meet, if painted. */
  doorStripe?: string;
  roof: string;
  /** End face: body colour, dark mask around the windscreen, lamp colour of the head. */
  face: string;
  mask?: string;
  /** Frame of light around the windscreen (MP 14), or none. */
  ledFrame?: boolean;
  /** Painted outline around the windscreen (MF 77 in IDFM livery), or none. */
  frame?: string;
}

export interface Stock {
  /** Cache key of the built mesh: same model, same cars. */
  model: string;
  name: string;
  cars: number;
  /** Pitch of one car (coupler to coupler), in metres. */
  carLength: number;
  width: number;
  /** Roof above the rail. */
  height: number;
  /** Floor above the rail: where the doors start. */
  floor: number;
  /** Doors per side and car, and the width of each opening. */
  doors: number;
  doorWidth: number;
  /** Rubber-tyred (MP) or steel-wheeled (MF). */
  tyres: boolean;
  /** Open gangways along the train (one long saloon) or separate cars. */
  gangway: boolean;
  /** Body sides made of inclined planes (MP 14, MF 19) or nearly upright. */
  inclined: boolean;
  /** Windscreen setback at roof height, in metres: 0 = flat face. */
  rake: number;
  livery: Livery;
}

// Sources (checked 23 Nov 2026): fr/en Wikipedia pages of each stock and line
// (edited Aug–Nov 2026), Métropolitor, RATP and IDFM press. Lengths, widths,
// heights, doors, gangways and tyres are sourced unless marked "estimate".
// Liveries are described in words there; colours and band heights are drawn
// from that description, not measured.

const WHITE = "#f4f5f7";
const JADE = "#00a38c"; // RATP jade green
const ANTHRACITE = "#3b3f46";
const SKY = "#6cc4ee";
const SILVER: [string, string] = ["#8d939c", "#a9afb8"];

/** Île-de-France Mobilités livery: white, silver foot, sky-blue roof line (MP 14, MF 19, renovated MF 77). */
const IDFM: Livery = {
  body: WHITE,
  skirt: SILVER,
  skirtTop: 0.98,
  bands: [
    { z0: 0.98, z1: 1.0, color: "#7d838c" },
    { z0: 3.1, z1: 3.2, color: SKY },
  ],
  door: "#fafbfc",
  doorFrame: "#c9ced6",
  doorStripe: SKY,
  roof: "#d3d7dd",
  face: WHITE,
  ledFrame: true,
};

/** RATP 1990s livery on the MP 89 / MP 05: white, wide anthracite window band edged by two jade lines. */
const RATP_MP: Livery = {
  body: WHITE,
  skirt: ["#c9cdd3", "#e4e6ea"],
  skirtTop: 0.9,
  bands: [
    { z0: 1.5, z1: 2.98, color: ANTHRACITE },
    { z0: 1.42, z1: 1.5, color: JADE },
    { z0: 2.98, z1: 3.06, color: JADE },
  ],
  door: "#e9ebee",
  doorFrame: "#9aa0a8",
  roof: "#c8ccd2",
  face: WHITE,
  mask: "#15181d",
};

/** RATP white and jade green (MF 67, MF 77 on line 13, MF 88): jade band under the windows, black face. */
const RATP_JADE: Livery = {
  body: WHITE,
  skirt: ["#b9bec5", "#d9dce1"],
  skirtTop: 0.8,
  bands: [
    { z0: 1.3, z1: 1.55, color: JADE },
    { z0: 3.02, z1: 3.08, color: JADE },
  ],
  door: "#eef0f2",
  doorFrame: "#a3a9b1",
  roof: "#b9bec5",
  face: WHITE,
  mask: "#121418",
};

/** MF 77 renovated in IDFM livery (lines 7, 8): white, wide grey foot, sky-blue roof line, blue outline round the windscreen. */
const MF77_IDFM: Livery = {
  ...IDFM,
  skirt: ["#80868f", "#9aa0a9"],
  skirtTop: 1.25,
  bands: [{ z0: 3.08, z1: 3.16, color: SKY }],
  ledFrame: false,
  frame: "#2f7fd0",
};

/** MF 01 in RATP livery (lines 2, 5): white, dark window band, jade line below, dark face mask (estimate). */
const MF01_RATP: Livery = {
  body: WHITE,
  skirt: ["#9aa0a8", "#c3c7cd"],
  skirtTop: 0.95,
  bands: [{ z0: 1.42, z1: 1.52, color: JADE }],
  windowStrip: ANTHRACITE,
  door: "#eef0f2",
  doorFrame: "#8f959d",
  roof: "#c3c7cd",
  face: WHITE,
  mask: "#14171c",
};

/** MF 01 in STIF livery (line 9): silver band at window height, jade stripes by the doors. */
const MF01_STIF: Livery = {
  ...MF01_RATP,
  bands: [],
  windowStrip: "#aeb4bc",
  doorFrame: JADE,
};

interface Shape {
  name: string;
  carLength: number;
  width: number;
  height: number;
  floor: number;
  doors: number;
  doorWidth: number;
  tyres: boolean;
  gangway: boolean;
  inclined: boolean;
  rake: number;
}

// Car pitch = train length / cars (end and middle cars differ by up to 0.9 m).
const MP14: Shape = { name: "MP 14", carLength: 15.04, width: 2.45, height: 3.5, floor: 1.1, doors: 3, doorWidth: 1.65, tyres: true, gangway: true, inclined: true, rake: 0 }; // height, floor: estimates
// MP 89 CC: driven, with a nose. 6 cars of 90.28 m, cut to 5 on line 6.
const MP89CC: Shape = { name: "MP 89 CC", carLength: 15.05, width: 2.448, height: 3.47, floor: 1.1, doors: 3, doorWidth: 1.65, tyres: true, gangway: true, inclined: true, rake: 0.75 };
// MP 05: the MP 89 CA body (automatic, panoramic end window), 6 cars of 90.28 m.
const MP05: Shape = { ...MP89CC, name: "MP 05", rake: 0.45 };
// MF 67: 4 doors of 1.30 m, separate cars, upright sides. 75.40 m (5 cars), 45.82 m (3 cars).
const MF67: Shape = { name: "MF 67", carLength: 15.08, width: 2.4, height: 3.35, floor: 1.05, doors: 4, doorWidth: 1.3, tyres: false, gangway: false, inclined: false, rake: 0.12 };
// MF 77: 3 doors of 1.575 m, separate cars, sides curved in at top and bottom. 77.4 m (5 cars).
const MF77: Shape = { name: "MF 77", carLength: 15.48, width: 2.46, height: 3.46, floor: 1.05, doors: 3, doorWidth: 1.575, tyres: false, gangway: false, inclined: true, rake: 0.25 };
// MF 88: MF 77-like body with gangways, 3 cars, 46.44 m. Height: estimate.
const MF88: Shape = { ...MF77, name: "MF 88", carLength: 15.48, width: 2.44, gangway: true, rake: 0.2 };
// MF 01: gangways, curved sides, large raked windscreen. 75.8 m (5 cars). Door width: estimate.
const MF01: Shape = { name: "MF 01", carLength: 15.16, width: 2.4, height: 3.46, floor: 1.05, doors: 3, doorWidth: 1.6, tyres: false, gangway: true, inclined: true, rake: 0.5 };

const make = (shape: Shape, cars: number, livery: Livery, carLength = shape.carLength): Stock => ({
  ...shape,
  carLength,
  model: `${shape.name}-${cars}-${livery === IDFM ? "idfm" : livery === RATP_MP ? "ratp" : livery === MF01_STIF ? "stif" : livery === MF77_IDFM ? "idfm77" : "jade"}`,
  cars,
  livery,
});

/** By line id, the stock that runs most of the service in November 2026. */
export const STOCK: Record<string, Stock> = {
  "1": make(MP05, 6, RATP_MP),
  "2": make(MF01, 5, MF01_RATP),
  "3": make(MF67, 5, RATP_JADE),
  "3B": make(MF67, 3, RATP_JADE, 15.27),
  // Mixed fleet, no majority: MP 89 CA (21), MP 14 (20, 4 more ordered), MP 05 (11).
  "4": make(MP14, 6, IDFM),
  "5": make(MF01, 5, MF01_RATP),
  // The last MP 73 ran on 8 July 2026: all MP 89 CC, shortened to 5 cars.
  "6": make(MP89CC, 5, RATP_MP),
  "7": make(MF77, 5, MF77_IDFM),
  // MF 88 until 12 December 2026, then MF 19.
  "7B": make(MF88, 3, RATP_JADE),
  // 44 of 62 trains renovated in IDFM livery (2023–2026).
  "8": make(MF77, 5, MF77_IDFM),
  "9": make(MF01, 5, MF01_STIF),
  // MF 67 (25) still ahead of MF 19 (7) in early November 2026.
  "10": make(MF67, 5, RATP_JADE),
  // MP 14 CC: driven, 5 cars.
  "11": make(MP14, 5, IDFM),
  "12": make(MF67, 5, RATP_JADE),
  "13": make(MF77, 5, RATP_JADE),
  // MP 14 CA: eight cars of 15.04 m, the only stock on line 14.
  "14": make(MP14, 8, IDFM),
};

export const stockLength = (s: Stock) => Math.round(s.cars * s.carLength * 100) / 100;
