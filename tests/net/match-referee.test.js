import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchReferee } from '../../src/net/match-referee.js';
import { VersusMatch } from '../../src/game/versus.js';

test('one wipe wins for the other seat after the draw window and the latency', () => {
  const referee = new MatchReferee();
  referee.reportWipe(1, 10);
  assert.equal(referee.decide(10.2, 0.05), null);
  assert.deepEqual(referee.decide(10.25, 0.05), { winner: 0, draw: false, hives: false });
  assert.equal(referee.decide(10.3, 0.05), null);
});

test('two wipes within 200 ms are a draw; further apart the later one wins', () => {
  const near = new MatchReferee();
  near.reportWipe(1, 10);
  near.reportWipe(0, 10.15);
  assert.deepEqual(near.decide(10.15, 0), { winner: null, draw: true, hives: false });
  const far = new MatchReferee();
  far.reportWipe(1, 10);
  far.reportWipe(0, 10.25);
  assert.deepEqual(far.decide(10.25, 0), { winner: 0, draw: false, hives: false });
});

test('a seat\'s first wipe counts, a repeat report does not move it', () => {
  const referee = new MatchReferee();
  referee.reportWipe(0, 5);
  referee.reportWipe(0, 6);
  assert.deepEqual(referee.decide(5.2, 0), { winner: 1, draw: false, hives: false });
});

test('nothing is decided without a wipe, and reset clears the wipes and the decision', () => {
  const referee = new MatchReferee({ drawWindowSeconds: 0.5 });
  assert.equal(referee.decide(100, 0), null);
  referee.reportWipe(1, 1);
  assert.equal(referee.decide(1.4, 0), null);
  assert.deepEqual(referee.decide(1.5, 0), { winner: 0, draw: false, hives: false });
  referee.reset();
  assert.equal(referee.decide(10, 0), null);
  referee.reportWipe(0, 10);
  assert.deepEqual(referee.decide(10.5, 0), { winner: 1, draw: false, hives: false });
});

test('VersusMatch.announce sets the result once', () => {
  const match = new VersusMatch();
  const result = { winner: 1, draw: false, hives: false };
  assert.equal(match.announce(result), result);
  assert.equal(match.result, result);
  assert.equal(match.over, true);
  assert.equal(match.announce({ winner: 0, draw: false, hives: false }), null);
  assert.equal(match.result, result);
});
