// CPU port of the fine pass in steer.wgsl (fineNeighborAverages, separation only), for the
// neighbor-cap gate in steer-check.js. It walks the GPU's own grid from the same step
// (cellCounts, cellOffsets, sortedIndices), so the within-cell order the atomic scatter produced
// is reproduced exactly. maximumSamples Infinity gives the uncapped average over every neighbor.
import { ARENA_HEIGHT, ARENA_WIDTH } from '/src/sim/layout.js';

const MINIMUM_LENGTH = 0.000001;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// grid: { columns, rows, cellSize, cellCounts, cellOffsets, sortedIndices }; positionOf(index)
// returns [x, y]. Returns the averaged separation vector [x, y] for agent index.
export function separationAverage({ index, positionOf, grid, radius, maximumSamples }) {
  const [x, y] = positionOf(index);
  const homeColumn = Math.min(Math.floor(clamp(x, 0, ARENA_WIDTH) / grid.cellSize), grid.columns - 1);
  const homeRow = Math.min(Math.floor(clamp(y, 0, ARENA_HEIGHT) / grid.cellSize), grid.rows - 1);
  const starts = [];
  const counts = [];
  let total = 0;
  for (let neighborCell = 0; neighborCell < 9; neighborCell += 1) {
    const column = homeColumn + (neighborCell % 3) - 1;
    const row = homeRow + Math.floor(neighborCell / 3) - 1;
    const inside = column >= 0 && row >= 0 && column < grid.columns && row < grid.rows;
    const cell = column + row * grid.columns;
    starts.push(inside ? grid.cellOffsets[cell] : 0);
    counts.push(inside ? grid.cellCounts[cell] : 0);
    total += counts[neighborCell];
  }
  const stride = Number.isFinite(maximumSamples) ? Math.max(1, Math.ceil(total / maximumSamples)) : 1;
  const sampleOffset = index % stride;
  const sum = [0, 0];
  let separationCount = 0;
  let sampled = 0;
  let cellBase = 0;
  for (let neighborCell = 0; neighborCell < 9; neighborCell += 1) {
    const first = (sampleOffset + stride - (cellBase % stride)) % stride;
    cellBase += counts[neighborCell];
    for (let local = first; local < counts[neighborCell] && sampled < maximumSamples; local += stride) {
      sampled += 1;
      const otherIndex = grid.sortedIndices[starts[neighborCell] + local];
      if (otherIndex === index) continue;
      const [otherX, otherY] = positionOf(otherIndex);
      const away = [x - otherX, y - otherY];
      const distanceSquared = away[0] * away[0] + away[1] * away[1];
      if (distanceSquared >= radius * radius || distanceSquared < MINIMUM_LENGTH * MINIMUM_LENGTH) continue;
      const distance = Math.sqrt(distanceSquared);
      const weight = (1 - distance / radius) / distance;
      sum[0] += away[0] * weight;
      sum[1] += away[1] * weight;
      separationCount += 1;
    }
  }
  return separationCount > 0 ? [sum[0] / separationCount, sum[1] / separationCount] : [0, 0];
}
