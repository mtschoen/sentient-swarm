// The color each player seat's swarm is drawn in: body is the linear RGB the swarm shader
// multiplies its white ship terms by, css is the same color for the HUD. Seat 1 is white (what the
// solo game always drew); seat 2 is green, away from the species hues.
export const SEAT_COLORS = [
  { body: [1, 1, 1], css: '#ffffff' },
  { body: [0.45, 1, 0.55], css: 'hsl(130, 90%, 65%)' },
];
