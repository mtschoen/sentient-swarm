// The one place the public STUN addresses live: primary first, fallback second. No TURN relay is configured.

export const ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: 'stun:stun.l.google.com:19302' }),
  Object.freeze({ urls: 'stun:stun.cloudflare.com:3478' }),
]);

// Candidate gathering is waited on for at most this long before the description is used as it stands.
export const ICE_GATHER_CAP_SECONDS = 3;
