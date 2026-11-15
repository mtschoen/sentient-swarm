import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnlinePanel } from '../../src/ui/online-panel.js';
import { encodeSignal } from '../../src/net/signal-codec.js';

const SAMPLE_SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

function createFakeDocument() {
  const make = (tagName) => {
    const classes = new Set();
    const listeners = {};
    return {
      tagName: tagName.toUpperCase(), textContent: '', value: '', children: [], hidden: false, attributes: {}, style: {},
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
      // Resolves when every listener, including async ones, has finished.
      fire(type, event = {}) {
        return Promise.all((listeners[type] ?? []).map((listener) => listener({ stopPropagation() {}, preventDefault() {}, ...event })));
      },
    };
  };
  return { createElement: make };
}

function allNodes(node) {
  return [node].concat((node.children ?? []).flatMap(allNodes));
}
const allButtons = (node) => allNodes(node).filter((child) => child.tagName === 'BUTTON');
const button = (panel, label) => allButtons(panel.element).find((node) => node.textContent === label);
const box = (panel) => allNodes(panel.element).find((node) => node.tagName === 'TEXTAREA');

function setup() {
  const documentObject = createFakeDocument();
  const parent = documentObject.createElement('div');
  const replies = [];
  const copies = [];
  let cancels = 0;
  const clipboard = {
    text: '', written: [], reject: false,
    async readText() { if (this.reject) throw new Error('denied'); return this.text; },
    async writeText(text) { this.written.push(text); },
  };
  const panel = createOnlinePanel(parent, {
    documentObject, clipboard,
    onReply: (text) => replies.push(text),
    onCopyReply: () => copies.push(true),
    onCancel: () => { cancels += 1; },
  });
  return { panel, parent, clipboard, replies, copies, cancelCount: () => cancels };
}

async function newerVersionAnswer() {
  const envelope = JSON.stringify({ v: 2, k: 'answer', s: SAMPLE_SDP });
  const stream = new Blob([new TextEncoder().encode(envelope)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return Buffer.from(new Uint8Array(await new Response(stream).arrayBuffer())).toString('base64url');
}

test('every button is laid out from the start in both modes', () => {
  const { panel } = setup();
  const count = allButtons(panel.element).length;
  panel.showHost();
  assert.equal(allButtons(panel.element).length, count);
  panel.showJoin();
  assert.equal(allButtons(panel.element).length, count);
  assert.equal(button(panel, 'Copy invite link').attributes['aria-disabled'], 'true');
  assert.equal(button(panel, 'Copy reply').attributes['aria-disabled'], 'true');
});

test('modes change visibility only', () => {
  const { panel } = setup();
  panel.showHost();
  assert.equal(button(panel, 'Paste reply').style.visibility, 'visible');
  assert.equal(button(panel, 'Copy reply').style.visibility, 'hidden');
  panel.showJoin();
  assert.equal(button(panel, 'Paste reply').style.visibility, 'hidden');
  assert.equal(button(panel, 'Copy reply').style.visibility, 'visible');
  assert.equal(panel.visible, true);
  panel.hide();
  assert.equal(panel.visible, false);
});

test('the invite and reply buttons wake up when their text arrives and copy it', async () => {
  const { panel, clipboard, copies } = setup();
  panel.setInvite('https://example.test/#join=abc');
  assert.equal(button(panel, 'Copy invite link').attributes['aria-disabled'], 'false');
  await button(panel, 'Copy invite link').fire('click');
  panel.setReply('replytext');
  await button(panel, 'Copy reply').fire('click');
  assert.deepEqual(clipboard.written, ['https://example.test/#join=abc', 'replytext']);
  assert.equal(copies.length, 1);
});

test('a ghosted copy button does nothing', async () => {
  const { panel, clipboard, copies } = setup();
  await button(panel, 'Copy reply').fire('click');
  await button(panel, 'Copy invite link').fire('click');
  assert.deepEqual(clipboard.written, []);
  assert.equal(copies.length, 0);
});

test('pasting the invite instead of a reply explains it and does not connect', async () => {
  const { panel, clipboard, replies } = setup();
  clipboard.text = await encodeSignal({ kind: 'offer', sdp: SAMPLE_SDP });
  await button(panel, 'Paste reply').fire('click');
  assert.equal(replies.length, 0);
  assert.match(panel.messageText, /invite link/);
});

test('a valid reply connects once even when pasted twice', async () => {
  const { panel, clipboard, replies } = setup();
  clipboard.text = await encodeSignal({ kind: 'answer', sdp: SAMPLE_SDP });
  await button(panel, 'Paste reply').fire('click');
  await button(panel, 'Paste reply').fire('click');
  assert.deepEqual(replies, [clipboard.text]);
  panel.showHost();
  await button(panel, 'Paste reply').fire('click');
  assert.equal(replies.length, 2, 'showHost re-arms the panel');
});

test('a refused clipboard read asks to paste into the box', async () => {
  const { panel, clipboard, replies } = setup();
  clipboard.reject = true;
  await button(panel, 'Paste reply').fire('click');
  assert.equal(panel.messageText, 'Paste the reply into the box.');
  assert.equal(replies.length, 0);
});

test('garbage and a newer protocol version give their messages', async () => {
  const { panel, replies } = setup();
  box(panel).value = 'hello';
  await box(panel).fire('keydown', { key: 'Enter' });
  assert.equal(panel.messageText, 'That is not a reply from this game.');
  const newer = await newerVersionAnswer();
  await box(panel).fire('paste', { clipboardData: { getData: () => newer } });
  assert.equal(panel.messageText, 'Both players need to reload the page.');
  assert.equal(replies.length, 0);
});

test('Enter in the box submits a valid reply, and Cancel calls back', async () => {
  const { panel, replies, cancelCount } = setup();
  box(panel).value = await encodeSignal({ kind: 'answer', sdp: SAMPLE_SDP });
  await box(panel).fire('keydown', { key: 'Enter' });
  assert.equal(replies.length, 1);
  await button(panel, 'Cancel').fire('click');
  assert.equal(cancelCount(), 1);
});

test('status, connecting and messages are text changes', () => {
  const { panel } = setup();
  panel.setConnecting();
  const count = allNodes(panel.element).length;
  panel.showMessage('hello');
  assert.equal(panel.messageText, 'hello');
  assert.equal(allNodes(panel.element).length, count);
});
