import { Simulation } from '../../src/sim/simulation.js';
import { defaultMatrix, defaultSpecies, normalizeShares } from '../../src/sim/species.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

// The constructor only creates buffers, so a fake device records the SimParams writes.
export function fakeSimulation() {
  const writes = [];
  const device = {
    createBuffer: (descriptor) => ({ ...descriptor, destroy() {} }),
    createBindGroup: (descriptor) => descriptor,
    queue: { writeBuffer: (buffer, offset, data) => writes.push({ buffer, data }) },
  };
  const simulation = new Simulation({ device }, { capacity: 64, neighborRadius: 0.25, species: defaultSpecies(), matrix: defaultMatrix(), shares: normalizeShares([1, 1, 1, 1, 1]), particleCapacity: 4 }, '');
  const paramsBounds = () => {
    const write = writes.filter(({ buffer }) => buffer === simulation.paramsBufferValue).at(-1);
    const view = new DataView(write.data);
    return [240, 244, 248, 252].map((offset) => view.getFloat32(offset, true));
  };
  return { simulation, paramsBounds, writes };
}
