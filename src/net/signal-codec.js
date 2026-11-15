// The invite and reply codec: a session description as base64url of deflate-raw over a small JSON envelope.

import { PROTOCOL_VERSION } from './protocol.js';

const JOIN_MARKER = '#join=';
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export class SignalError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'SignalError';
    this.reason = reason;
  }
}

async function collect(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function encodeSignal({ kind, sdp }) {
  const json = JSON.stringify({ v: PROTOCOL_VERSION, k: kind, s: sdp });
  const stream = new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return toBase64Url(await collect(stream));
}

export function inviteUrl(locationHref, encoded) {
  const hashIndex = locationHref.indexOf('#');
  const base = hashIndex === -1 ? locationHref : locationHref.slice(0, hashIndex);
  return `${base}${JOIN_MARKER}${encoded}`;
}

export function inviteFromHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(JOIN_MARKER)) return null;
  const payload = hash.slice(JOIN_MARKER.length);
  return payload.length > 0 ? payload : null;
}

async function inflate(bytes) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await collect(stream);
  } catch {
    throw new SignalError('malformed', 'The text is not a valid code.');
  }
}

export async function decodeSignal(text, expectedKind) {
  let payload = String(text ?? '').trim();
  const markerIndex = payload.indexOf(JOIN_MARKER);
  if (markerIndex !== -1) payload = payload.slice(markerIndex + JOIN_MARKER.length).trim();
  if (!BASE64_URL_PATTERN.test(payload)) throw new SignalError('malformed', 'The text is not a valid code.');
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await inflate(fromBase64Url(payload))));
  } catch (error) {
    if (error instanceof SignalError) throw error;
    throw new SignalError('malformed', 'The text is not a valid code.');
  }
  if (envelope === null || typeof envelope !== 'object' || typeof envelope.k !== 'string' || typeof envelope.s !== 'string' || typeof envelope.v !== 'number') {
    throw new SignalError('malformed', 'The text is not a valid code.');
  }
  if (envelope.v !== PROTOCOL_VERSION) throw new SignalError('version', 'The other player runs a different version.');
  if (envelope.k !== expectedKind) throw new SignalError('wrongKind', `Expected an ${expectedKind} code but got an ${envelope.k} code.`);
  return { kind: envelope.k, sdp: envelope.s };
}
