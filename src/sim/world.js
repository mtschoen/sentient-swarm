// World constants: the one source of the world's size for the CPU and, through SHADER_CONSTANTS in
// layout.js, for every shader (common.wgsl's WORLD_WIDTH and WORLD_HEIGHT). The world is the area
// the simulation covers: the coarse field and the neighbor grid span it, agents and the player stay
// inside it. The view is what one window shows at camera zoom 1: the largest rectangle of the
// canvas aspect inside a VIEW_WIDTH by VIEW_HEIGHT screen (16 by 9 world units), so a 16:9 window
// sees 16 by 9 units and a narrower or wider one a full-height column or a full-width strip.
// Aspects outside [MINIMUM_VIEW_ASPECT, MAXIMUM_VIEW_ASPECT] are clamped (the viewport letterboxes
// the rest). Pure: no GPU.

export const WORLD_WIDTH = 16;
export const WORLD_HEIGHT = 9;
// The view at camera zoom 1 for a 16:9 window.
export const VIEW_WIDTH = 16;
export const VIEW_HEIGHT = 9;
export const MINIMUM_VIEW_ASPECT = 0.25;
export const MAXIMUM_VIEW_ASPECT = 4;

// A coarse field cell is this many world units on a side. targetDensity is agents per coarse cell,
// so the cell size sets the swarm's feel and stays fixed whatever the world size.
export const COARSE_CELL_SIZE = 0.25;
export const COARSE_COLUMNS = WORLD_WIDTH / COARSE_CELL_SIZE;
export const COARSE_ROWS = WORLD_HEIGHT / COARSE_CELL_SIZE;

// The neighbor grid's block sums are scanned by a single 256-wide workgroup (grid_scan.wgsl), so the
// grid holds at most 256 blocks of 256 cells.
export const MAXIMUM_GRID_CELLS = 256 * 256;
// Growth factor per try when the cell size is raised to fit MAXIMUM_GRID_CELLS.
const CELL_SIZE_GROWTH = 1.0001;

// { minX, minY, maxX, maxY, width, height }, frozen, centered on (centerX, centerY).
export function boundsAround(centerX, centerY, width, height) {
  const minX = centerX - width / 2;
  const minY = centerY - height / 2;
  return Object.freeze({ minX, minY, maxX: minX + width, maxY: minY + height, width, height });
}

// The whole world.
export const WORLD_BOUNDS = boundsAround(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, WORLD_WIDTH, WORLD_HEIGHT);

// The view's { width, height } in world units at zoom 1 for a canvas aspect (width over height).
// A non-positive or non-finite aspect gives the 16:9 view.
export function viewSizeForAspect(aspect) {
  const fallback = VIEW_WIDTH / VIEW_HEIGHT;
  const requested = Number.isFinite(aspect) && aspect > 0 ? aspect : fallback;
  const ratio = Math.min(MAXIMUM_VIEW_ASPECT, Math.max(MINIMUM_VIEW_ASPECT, requested));
  return Object.freeze({ width: Math.min(VIEW_WIDTH, VIEW_HEIGHT * ratio), height: Math.min(VIEW_HEIGHT, VIEW_WIDTH / ratio) });
}

// Neighbor grid for a neighbor radius: cells of side cellSize cover the world. The cell is the
// radius unless that would need more than MAXIMUM_GRID_CELLS cells; then it grows to the smallest
// size that fits (cell at least the radius keeps the 3 by 3 neighborhood scan correct).
export function gridDimensions(neighborRadius) {
  let cellSize = Math.max(neighborRadius, Math.sqrt((WORLD_WIDTH * WORLD_HEIGHT) / MAXIMUM_GRID_CELLS));
  const cellsFor = (size) => Math.ceil(WORLD_WIDTH / size) * Math.ceil(WORLD_HEIGHT / size);
  while (cellsFor(cellSize) > MAXIMUM_GRID_CELLS) cellSize *= CELL_SIZE_GROWTH;
  const columns = Math.ceil(WORLD_WIDTH / cellSize);
  const rows = Math.ceil(WORLD_HEIGHT / cellSize);
  return { columns, rows, cellSize, cellCount: columns * rows };
}
