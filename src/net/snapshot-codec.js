// The binary SeatSnapshot (state channel). Layout is pinned in the online design: header, point,
// weapons, ships (alive bitmap, quantized positions, generations, gunners), beam, host block and
// host state. Positions are 16-bit over the world; headings 8-bit over [-PI, PI].

import { WORLD_HEIGHT, WORLD_WIDTH } from '../sim/world.js';
import { ByteReader, ByteWriter, dequantize, quantize } from './byte-buffer.js';
import { MESSAGE_SNAPSHOT, WEAPON_KIND_CODES } from './protocol.js';

const SLOT_COUNT = 256;
const BITMAP_BYTES = SLOT_COUNT / 8;
const NONE = 255;
const FLAG_FIRING = 1;
const FLAG_INVULNERABLE = 2;
const FLAG_BEAM = 4;
const FLAG_HOST = 8;
const FLAG_HOST_STATE = 16;

const quantizeUnit = (value, bits) => quantize(value, 0, 1, bits);
const dequantizeUnit = (code, bits) => dequantize(code, 0, 1, bits);
const nullable = (value) => (value === null || value === undefined ? NONE : value);
const denull = (code) => (code === NONE ? null : code);

function writeHeader(writer, snapshot) {
  const flags = (snapshot.firing ? FLAG_FIRING : 0) | (snapshot.invulnerable ? FLAG_INVULNERABLE : 0)
    | (snapshot.beam ? FLAG_BEAM : 0) | (snapshot.host ? FLAG_HOST : 0) | (snapshot.hostState ? FLAG_HOST_STATE : 0);
  writer.u8(MESSAGE_SNAPSHOT);
  writer.u32(snapshot.sequence);
  writer.f64(snapshot.matchSeconds);
  writer.u8(snapshot.seat);
  writer.u8(flags);
}

function writePointAndWeapons(writer, snapshot) {
  const { point, aim, weapons } = snapshot;
  writer.u16(quantize(point.x, 0, WORLD_WIDTH, 16));
  writer.u16(quantize(point.y, 0, WORLD_HEIGHT, 16));
  for (const value of [point.velocityX, point.velocityY, aim.x, aim.y]) writer.f32(value);
  const armed = WEAPON_KIND_CODES.indexOf(weapons.armed);
  if (armed < 0) throw new RangeError(`unknown weapon kind ${weapons.armed}`);
  writer.u8(armed);
  writer.u8(weapons.tier);
  writer.u16(quantizeUnit(weapons.charge, 16));
  writer.u8(weapons.railTurrets);
  writer.u8(weapons.railTier);
}

function writeShips(writer, ships) {
  const bitmap = new Uint8Array(BITMAP_BYTES);
  for (const ship of ships) bitmap[ship.slot >> 3] |= 1 << (ship.slot & 7);
  for (const byte of bitmap) writer.u8(byte);
  for (const ship of ships) {
    writer.u16(quantize(ship.x, 0, WORLD_WIDTH, 16));
    writer.u16(quantize(ship.y, 0, WORLD_HEIGHT, 16));
    writer.u8(quantize(ship.heading, -Math.PI, Math.PI, 8));
  }
  for (let index = 0; index < ships.length; index += 2) {
    const high = index + 1 < ships.length ? ships[index + 1].generation & 15 : 0;
    writer.u8((ships[index].generation & 15) | (high << 4));
  }
  const gunners = ships.filter((ship) => ship.gunnerIndex !== null && ship.gunnerIndex !== undefined);
  writer.u8(gunners.length);
  for (const ship of gunners) {
    writer.u8(ship.slot);
    writer.u8(ship.gunnerIndex);
  }
}

function writeGates(writer, gates) {
  writer.u8(gates ? gates.gates.length : NONE);
  if (gates) {
    for (const gate of gates.gates) {
      for (const value of [gate.x, gate.y, gate.radius]) writer.f32(value);
      writer.u8(gate.emit);
      writer.u8(gate.species);
      writer.u8(quantizeUnit(gate.open, 8));
      writer.u8(quantizeUnit(gate.telegraph, 8));
      writer.u8(nullable(gate.site));
    }
  }
  writer.f32(gates ? gates.speciesBias : 0);
}

function writeHostBlock(writer, host) {
  writeGates(writer, host.gates);
  writer.u8(host.wave ? 1 : 0);
  if (host.wave) {
    writer.u8(host.wave.emitting);
    writer.f32(host.wave.remainingSeconds);
    writer.f32(host.wave.burstFraction);
  }
}

function writeHostState(writer, state) {
  writer.u32(state.sequence);
  writer.u8(state.hives ? state.hives.length : 0);
  for (const hive of state.hives ?? []) {
    writer.u8(nullable(hive.owner));
    writer.u8(nullable(hive.capturer));
    writer.u16(quantizeUnit(hive.progress, 16));
  }
  writer.u8(nullable(state.holder));
  writer.f32(state.holdSeconds);
  writer.f64(state.score);
  writer.u8(state.multiplier);
  writer.u8(state.bombs);
}

export function encodeSnapshot(snapshot) {
  const writer = new ByteWriter();
  writeHeader(writer, snapshot);
  writePointAndWeapons(writer, snapshot);
  writeShips(writer, snapshot.ships);
  if (snapshot.beam) {
    const { x, y, directionX, directionY, halfWidth } = snapshot.beam;
    for (const value of [x, y, directionX, directionY, halfWidth]) writer.f32(value);
  }
  if (snapshot.host) writeHostBlock(writer, snapshot.host);
  if (snapshot.hostState) writeHostState(writer, snapshot.hostState);
  return writer.bytes();
}

function readShips(reader) {
  const slots = [];
  for (let byteIndex = 0; byteIndex < BITMAP_BYTES; byteIndex += 1) {
    const byte = reader.u8();
    for (let bit = 0; bit < 8; bit += 1) if (byte & (1 << bit)) slots.push(byteIndex * 8 + bit);
  }
  const ships = slots.map((slot) => ({
    slot,
    x: dequantize(reader.u16(), 0, WORLD_WIDTH, 16),
    y: dequantize(reader.u16(), 0, WORLD_HEIGHT, 16),
    heading: dequantize(reader.u8(), -Math.PI, Math.PI, 8),
    gunnerIndex: null,
    generation: 0,
  }));
  for (let index = 0; index < ships.length; index += 2) {
    const byte = reader.u8();
    ships[index].generation = byte & 15;
    if (index + 1 < ships.length) ships[index + 1].generation = byte >> 4;
  }
  const gunnerCount = reader.u8();
  for (let index = 0; index < gunnerCount; index += 1) {
    const slot = reader.u8();
    const gunnerIndex = reader.u8();
    const ship = ships.find((candidate) => candidate.slot === slot);
    if (ship) ship.gunnerIndex = gunnerIndex;
  }
  return ships;
}

function readGates(reader) {
  const count = reader.u8();
  const gates = [];
  const present = count !== NONE;
  for (let index = 0; present && index < count; index += 1) {
    const gate = { x: reader.f32(), y: reader.f32(), radius: reader.f32(), emit: reader.u8(), species: reader.u8() };
    gate.open = dequantizeUnit(reader.u8(), 8);
    gate.telegraph = dequantizeUnit(reader.u8(), 8);
    const site = reader.u8();
    if (site !== NONE) gate.site = site;
    gates.push(gate);
  }
  const speciesBias = reader.f32();
  return present ? { gates, speciesBias } : null;
}

function readHostBlock(reader) {
  const gates = readGates(reader);
  const wave = reader.u8() ? { emitting: reader.u8(), remainingSeconds: reader.f32(), burstFraction: reader.f32() } : null;
  return { gates, wave };
}

function readHostState(reader) {
  const sequence = reader.u32();
  const hiveCount = reader.u8();
  const hives = [];
  for (let index = 0; index < hiveCount; index += 1) {
    hives.push({ owner: denull(reader.u8()), capturer: denull(reader.u8()), progress: dequantizeUnit(reader.u16(), 16) });
  }
  return {
    sequence,
    hives: hiveCount ? hives : null,
    holder: denull(reader.u8()),
    holdSeconds: reader.f32(),
    score: reader.f64(),
    multiplier: reader.u8(),
    bombs: reader.u8(),
  };
}

export function decodeSnapshot(bytes) {
  const reader = new ByteReader(bytes);
  const type = reader.u8();
  if (type !== MESSAGE_SNAPSHOT) throw new RangeError(`not a snapshot: message type ${type}`);
  const sequence = reader.u32();
  const matchSeconds = reader.f64();
  const seat = reader.u8();
  const flags = reader.u8();
  const point = { x: dequantize(reader.u16(), 0, WORLD_WIDTH, 16), y: dequantize(reader.u16(), 0, WORLD_HEIGHT, 16) };
  point.velocityX = reader.f32();
  point.velocityY = reader.f32();
  const aim = { x: reader.f32(), y: reader.f32() };
  const armedCode = reader.u8();
  if (armedCode >= WEAPON_KIND_CODES.length) throw new RangeError(`unknown weapon code ${armedCode}`);
  const weapons = {
    armed: WEAPON_KIND_CODES[armedCode],
    tier: reader.u8(),
    charge: dequantizeUnit(reader.u16(), 16),
    railTurrets: reader.u8(),
    railTier: reader.u8(),
  };
  const ships = readShips(reader);
  const beam = flags & FLAG_BEAM
    ? { x: reader.f32(), y: reader.f32(), directionX: reader.f32(), directionY: reader.f32(), halfWidth: reader.f32() }
    : null;
  const host = flags & FLAG_HOST ? readHostBlock(reader) : null;
  const hostState = flags & FLAG_HOST_STATE ? readHostState(reader) : null;
  return {
    type: 'snapshot',
    sequence,
    matchSeconds,
    seat,
    point,
    aim,
    firing: Boolean(flags & FLAG_FIRING),
    invulnerable: Boolean(flags & FLAG_INVULNERABLE),
    weapons,
    aliveCount: ships.length,
    ships,
    beam,
    host,
    hostState,
  };
}
