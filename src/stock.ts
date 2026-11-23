// Rolling stock drawn as a real mesh when a train is opened (see train-mesh.ts).
// Kept apart from the mesh code so that the page knows which lines have a
// model without downloading three.js.
//
// The feed names no trainset or stock type: a train gets the stock of its line.

export interface Stock {
  model: "mp14";
  name: string;
  cars: number;
  /** Length of one car, in metres. */
  carLength: number;
}

/** By line id. Lines without an entry keep the extruded model of train3d.ts. */
export const STOCK: Record<string, Stock> = {
  // MP 14 CA: eight cars of 15.04 m, the only stock on line 14.
  "14": { model: "mp14", name: "MP 14", cars: 8, carLength: 15.04 },
};

export const stockLength = (s: Stock) => Math.round(s.cars * s.carLength * 100) / 100;
