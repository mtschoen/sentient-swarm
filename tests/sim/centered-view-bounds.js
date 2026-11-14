// Test helper: the view for a canvas aspect centered on the world center, as world bounds.
import { WORLD_HEIGHT, WORLD_WIDTH, boundsAround, viewSizeForAspect } from '../../src/sim/layout.js';

export function centeredViewBounds(aspect) {
  const view = viewSizeForAspect(aspect);
  return boundsAround(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, view.width, view.height);
}
