// Ship silhouettes for the glyph pass, prepended to glyphs.wgsl after common.wgsl and quad.wgsl (see glyphs.js).
// Signed distance fields built from Inigo Quilez's 2D primitives
// (https://iquilezles.org/articles/distfunctions2d): negative inside, positive outside, in local
// glyph units where +x is the nose, the body lies inside [-1, 1] and the glow reaches glowScale.
// Unions use min, subtractions max(a, -b). Mirror-symmetric parts fold y with abs.

fn boxDistance(point: vec2f, halfExtent: vec2f) -> f32 {
  let outside = abs(point) - halfExtent;
  return length(max(outside, vec2f(0.0))) + min(max(outside.x, outside.y), 0.0);
}

fn circleDistance(point: vec2f, center: vec2f, radius: f32) -> f32 {
  return length(point - center) - radius;
}

// Scaled-circle ellipse approximation: exact on the axes, close enough for a one-pixel rim.
fn ellipseDistance(point: vec2f, radii: vec2f) -> f32 {
  return (length(point / radii) - 1.0) * min(radii.x, radii.y);
}

// Inigo Quilez's general triangle through corners first, second and third.
fn triangleDistance(point: vec2f, first: vec2f, second: vec2f, third: vec2f) -> f32 {
  let edge0 = second - first;
  let edge1 = third - second;
  let edge2 = first - third;
  let offset0 = point - first;
  let offset1 = point - second;
  let offset2 = point - third;
  let nearest0 = offset0 - edge0 * clamp(dot(offset0, edge0) / dot(edge0, edge0), 0.0, 1.0);
  let nearest1 = offset1 - edge1 * clamp(dot(offset1, edge1) / dot(edge1, edge1), 0.0, 1.0);
  let nearest2 = offset2 - edge2 * clamp(dot(offset2, edge2) / dot(edge2, edge2), 0.0, 1.0);
  let orientation = sign(edge0.x * edge2.y - edge0.y * edge2.x);
  let distances = min(min(
    vec2f(dot(nearest0, nearest0), orientation * (offset0.x * edge0.y - offset0.y * edge0.x)),
    vec2f(dot(nearest1, nearest1), orientation * (offset1.x * edge1.y - offset1.y * edge1.x))),
    vec2f(dot(nearest2, nearest2), orientation * (offset2.x * edge2.y - offset2.y * edge2.x)));
  return -sqrt(distances.x) * sign(distances.y);
}

// Inigo Quilez's isosceles triangle with its apex at apexX on the axis, pointing along +x, and a
// base of halfWidth at apexX - height.
fn isoscelesTriangleDistance(point: vec2f, apexX: f32, halfWidth: f32, height: f32) -> f32 {
  let folded = vec2f(abs(point.y), apexX - point.x);
  let extent = vec2f(halfWidth, height);
  let toEdge = folded - extent * clamp(dot(folded, extent) / dot(extent, extent), 0.0, 1.0);
  let toBase = folded - extent * vec2f(clamp(folded.x / extent.x, 0.0, 1.0), 1.0);
  let side = -sign(extent.y);
  let distances = min(
    vec2f(dot(toEdge, toEdge), side * (folded.x * extent.y - folded.y * extent.x)),
    vec2f(dot(toBase, toBase), side * (folded.y - extent.y)));
  return -sqrt(distances.x) * sign(distances.y);
}

// Inigo Quilez's isosceles trapezoid along x: rearHalfWidth at centerX - halfLength,
// frontHalfWidth at centerX + halfLength.
fn trapezoidDistance(point: vec2f, centerX: f32, rearHalfWidth: f32, frontHalfWidth: f32, halfLength: f32) -> f32 {
  let local = vec2f(abs(point.y), point.x - centerX);
  let frontCorner = vec2f(frontHalfWidth, halfLength);
  let slant = vec2f(frontHalfWidth - rearHalfWidth, 2.0 * halfLength);
  let capWidth = select(frontHalfWidth, rearHalfWidth, local.y < 0.0);
  let toCap = vec2f(local.x - min(local.x, capWidth), abs(local.y) - halfLength);
  let toSlant = local - frontCorner + slant * clamp(dot(frontCorner - local, slant) / dot(slant, slant), 0.0, 1.0);
  let inside = toSlant.x < 0.0 && toCap.y < 0.0;
  return select(1.0, -1.0, inside) * sqrt(min(dot(toCap, toCap), dot(toSlant, toSlant)));
}

// 0 Chaser: a long narrow dart with two small swept fins at the tail.
fn chaserDistance(point: vec2f) -> f32 {
  let hull = isoscelesTriangleDistance(point, 1.0, 0.26, 1.7);
  let folded = vec2f(point.x, abs(point.y));
  let fin = triangleDistance(folded, vec2f(-0.3, 0.12), vec2f(-0.98, 0.66), vec2f(-0.78, 0.12));
  return min(hull, fin);
}

// 1 Orbiter: a wide flat saucer with a small forward dome (ringed by a one-pixel gap) and a
// notch cut into the rear so the facing reads.
fn orbiterDistance(point: vec2f) -> f32 {
  let saucer = ellipseDistance(point, vec2f(0.62, 0.96));
  let dome = circleDistance(point, vec2f(0.12, 0.0), 0.3);
  let domeGap = abs(dome) - 0.07;
  let notch = isoscelesTriangleDistance(point, -0.22, 0.34, 0.6);
  return max(max(saucer, -domeGap), -notch);
}

// 2 Skittish: a trapezoid fuselage with a pointed nose and two backswept wings.
fn skittishDistance(point: vec2f) -> f32 {
  let fuselage = trapezoidDistance(point, 0.0, 0.17, 0.08, 0.6);
  let nose = isoscelesTriangleDistance(point, 1.0, 0.08, 0.42);
  let folded = vec2f(point.x, abs(point.y));
  let wing = triangleDistance(folded, vec2f(0.3, 0.08), vec2f(-0.58, 0.96), vec2f(-0.32, 0.08));
  return min(min(fuselage, nose), wing);
}

// 3 Lattice: a heavy rectangular hull with a blunt wedge nose and two stub fins at the rear.
fn latticeDistance(point: vec2f) -> f32 {
  let hull = boxDistance(point - vec2f(-0.2, 0.0), vec2f(0.66, 0.42));
  let wedge = trapezoidDistance(point, 0.66, 0.42, 0.2, 0.2);
  let folded = vec2f(point.x, abs(point.y));
  let fin = boxDistance(folded - vec2f(-0.66, 0.54), vec2f(0.2, 0.14));
  return min(min(hull, wedge), fin);
}

// 4 Predator: a crescent body opening forward with two long prongs reaching past it.
fn predatorDistance(point: vec2f) -> f32 {
  let outer = circleDistance(point, vec2f(-0.32, 0.0), 0.62);
  let inner = circleDistance(point, vec2f(0.12, 0.0), 0.42);
  let crescent = max(outer, -inner);
  let folded = vec2f(point.x, abs(point.y));
  let prong = triangleDistance(folded, vec2f(-0.2, 0.66), vec2f(1.0, 0.34), vec2f(-0.05, 0.38));
  return min(crescent, prong);
}

// Species index selects the ship.
fn shipDistance(species: u32, point: vec2f) -> f32 {
  switch species {
    case 0u: { return chaserDistance(point); }
    case 1u: { return orbiterDistance(point); }
    case 2u: { return skittishDistance(point); }
    case 3u: { return latticeDistance(point); }
    default: { return predatorDistance(point); }
  }
}

// Local x of the engine nozzle on the ship's axis; the exhaust plume trails back from it.
fn shipNozzleX(species: u32) -> f32 {
  switch species {
    case 0u: { return -0.7; }
    case 1u: { return -0.5; }
    case 2u: { return -0.6; }
    case 3u: { return -0.86; }
    default: { return -0.94; }
  }
}
