// The binary events (reliable channel). One type code per event from FIRST_EVENT_CODE up, in the
// order of EVENT_SCHEMAS. A pickup's type field is `pickupType` because `type` names the event.

import { PICKUP_TYPE_NAMES } from '../game/weaponTypes.js';
import { ByteReader, ByteWriter } from './byte-buffer.js';
import { FIRST_EVENT_CODE, ONLINE_MODES } from './protocol.js';

const NONE = 255;

function indexIn(list, value, label) {
  const index = list.indexOf(value);
  if (index < 0) throw new RangeError(`unknown ${label} ${value}`);
  return index;
}

function fromIndex(list, index, label) {
  if (index >= list.length) throw new RangeError(`unknown ${label} code ${index}`);
  return list[index];
}

// Field kinds: a primitive width, or an object with write(writer, value) and read(reader).
const mode = {
  write: (writer, value) => writer.u8(indexIn(ONLINE_MODES, value, 'online mode')),
  read: (reader) => fromIndex(ONLINE_MODES, reader.u8(), 'online mode'),
};
const pickupType = {
  write: (writer, value) => writer.u8(indexIn(PICKUP_TYPE_NAMES, value, 'pickup type')),
  read: (reader) => fromIndex(PICKUP_TYPE_NAMES, reader.u8(), 'pickup type'),
};
const spawnFields = ['x', 'y', 'velocityX', 'velocityY', 'radius', 'lifetime'];
const spawns = {
  write(writer, list) {
    writer.u16(list.length);
    for (const spawn of list) {
      for (const field of spawnFields) writer.f32(spawn[field]);
      writer.u8(spawn.kind);
      writer.f32(spawn.seed);
      writer.f32(spawn.extra);
    }
  },
  read(reader) {
    const count = reader.u16();
    const list = [];
    for (let index = 0; index < count; index += 1) {
      const spawn = {};
      for (const field of spawnFields) spawn[field] = reader.f32();
      spawn.kind = reader.u8();
      spawn.seed = reader.f32();
      spawn.extra = reader.f32();
      list.push(spawn);
    }
    return list;
  },
};
const kills = {
  write(writer, list) {
    writer.u16(list.length);
    for (const kill of list) {
      writer.u8(kill.slot);
      writer.u8(kill.generation);
    }
  },
  read(reader) {
    const count = reader.u16();
    const list = [];
    for (let index = 0; index < count; index += 1) list.push({ slot: reader.u8(), generation: reader.u8() });
    return list;
  },
};
// Winner (255 for null) then the draw and hives flag bits; the one custom field reads three names.
const resultFields = {
  write(writer, event) {
    writer.u8(event.winner === null ? NONE : event.winner);
    writer.u8((event.draw ? 1 : 0) | (event.hives ? 2 : 0));
  },
  read(reader) {
    const winner = reader.u8();
    const flags = reader.u8();
    return { winner: winner === NONE ? null : winner, draw: Boolean(flags & 1), hives: Boolean(flags & 2) };
  },
};

const EVENT_SCHEMAS = Object.freeze([
  ['hello', [['version', 'u8']]],
  ['ping', [['sessionSeconds', 'f64'], ['matchSeconds', 'f64']]],
  ['pong', [['echoSessionSeconds', 'f64'], ['sessionSeconds', 'f64'], ['matchSeconds', 'f64']]],
  ['ready', []],
  ['titleMode', [['mode', mode]]],
  ['start', [['mode', mode], ['startSessionSeconds', 'f64']]],
  ['restartRequest', []],
  ['restart', [['startSessionSeconds', 'f64']]],
  ['pause', [['seat', 'u8']]],
  ['resumeRequest', []],
  ['resumeCountdown', [['endSessionSeconds', 'f64']]],
  ['quit', []],
  ['shots', [['owner', 'u8'], ['matchSeconds', 'f64'], ['spawns', spawns]]],
  ['contactKills', [['kills', kills]]],
  ['pickupAnnounced', [['id', 'u32'], ['pickupType', pickupType], ['x', 'f32'], ['y', 'f32']]],
  ['pickupExpired', [['id', 'u32']]],
  ['pickupClaim', [['id', 'u32'], ['x', 'f32'], ['y', 'f32']]],
  ['pickupCollected', [['id', 'u32'], ['seat', 'u8'], ['pickupType', pickupType], ['x', 'f32'], ['y', 'f32']]],
  ['bombRequest', [['x', 'f32'], ['y', 'f32']]],
  ['bombAnnounced', [['seat', 'u8'], ['x', 'f32'], ['y', 'f32']]],
  ['hiveCaptured', [['hive', 'u8'], ['seat', 'u8']]],
  ['wiped', [['seat', 'u8'], ['matchSeconds', 'f64']]],
  ['result', resultFields],
]);

export const EVENT_TYPES = Object.freeze(EVENT_SCHEMAS.map(([name]) => name));
const SCHEMA_BY_NAME = new Map(EVENT_SCHEMAS.map(([name, fields], index) => [name, { code: FIRST_EVENT_CODE + index, fields }]));

export function encodeEvent(event) {
  const schema = SCHEMA_BY_NAME.get(event.type);
  if (!schema) throw new RangeError(`unknown event type ${event.type}`);
  const writer = new ByteWriter();
  writer.u8(schema.code);
  if (!Array.isArray(schema.fields)) schema.fields.write(writer, event);
  else {
    for (const [name, kind] of schema.fields) {
      if (typeof kind === 'string') writer[kind](event[name]);
      else kind.write(writer, event[name]);
    }
  }
  return writer.bytes();
}

export function decodeEvent(bytes) {
  const reader = new ByteReader(bytes);
  const code = reader.u8();
  const index = code - FIRST_EVENT_CODE;
  if (index < 0 || index >= EVENT_SCHEMAS.length) throw new RangeError(`unknown event type code ${code}`);
  const [type, fields] = EVENT_SCHEMAS[index];
  if (!Array.isArray(fields)) return { type, ...fields.read(reader) };
  const event = { type };
  for (const [name, kind] of fields) event[name] = typeof kind === 'string' ? reader[kind]() : kind.read(reader);
  return event;
}
