// The Host and Join panels of online play. One panel holds both modes: every element exists from
// creation and a mode only changes text, visibility and the ghosting of the copy buttons, so nothing
// pops in or moves. Host: copy the invite link, paste the friend's reply (Paste reply, the Enter key or
// a paste into the box). Join: copy the reply and send it back. A reply is checked with decodeSignal
// before onReply sees it, and only one reply is accepted until showHost() again.
import { SignalError, decodeSignal } from '../net/signal-codec.js';

const MESSAGES = Object.freeze({
  malformed: 'That is not a reply from this game.',
  wrongKind: 'That is the invite link. Your friend opens it and sends you back the reply.',
  version: 'Both players need to reload the page.',
});
const CLIPBOARD_REFUSED = 'Paste the reply into the box.';
const COPY_REFUSED = 'Copying was refused. Try again.';

export function createOnlinePanel(parent, { documentObject = document, clipboard = navigator.clipboard, onReply, onCopyReply = () => {}, onCancel }) {
  const make = (tagName, className, textContent = '') => {
    const created = documentObject.createElement(tagName);
    created.className = className;
    created.textContent = textContent;
    return created;
  };
  const element = make('div', 'online-panel');
  element.setAttribute('role', 'dialog');
  const status = make('div', 'online-panel-status');
  const message = make('div', 'online-panel-message');
  const copyInvite = make('button', 'online-panel-button', 'Copy invite link');
  const replyBox = make('textarea', 'online-panel-box');
  replyBox.setAttribute('placeholder', 'Paste the reply here');
  replyBox.setAttribute('rows', '3');
  const pasteReply = make('button', 'online-panel-button', 'Paste reply');
  const copyReply = make('button', 'online-panel-button', 'Copy reply');
  const cancel = make('button', 'online-panel-button', 'Cancel');
  element.append(status, message, copyInvite, replyBox, pasteReply, copyReply, cancel);
  parent.append(element);

  let inviteText = null;
  let replyText = null;
  let accepted = false;
  let visible = true;

  const setGhosted = (control, ghosted) => {
    control.setAttribute('aria-disabled', ghosted ? 'true' : 'false');
    control.classList.toggle('online-panel-disabled', ghosted);
  };
  const setShown = (control, shown) => { control.style.visibility = shown ? 'visible' : 'hidden'; };
  setGhosted(copyInvite, true);
  setGhosted(copyReply, true);

  function setMode(host) {
    setShown(copyInvite, host);
    setShown(replyBox, host);
    setShown(pasteReply, host);
    setShown(copyReply, !host);
  }

  async function copy(text, then) {
    if (text === null) return;
    try {
      await clipboard.writeText(text);
    } catch {
      message.textContent = COPY_REFUSED;
      return;
    }
    then?.();
  }

  async function submit(text) {
    if (accepted) return;
    try {
      await decodeSignal(text, 'answer');
    } catch (error) {
      message.textContent = error instanceof SignalError ? (MESSAGES[error.reason] ?? MESSAGES.malformed) : MESSAGES.malformed;
      return;
    }
    if (accepted) return;
    accepted = true;
    message.textContent = '';
    onReply(text);
  }

  copyInvite.addEventListener('click', () => copy(inviteText));
  copyReply.addEventListener('click', () => copy(replyText, onCopyReply));
  pasteReply.addEventListener('click', async () => {
    if (accepted) return;
    let text;
    try {
      text = await clipboard.readText();
    } catch {
      message.textContent = CLIPBOARD_REFUSED;
      return;
    }
    if (accepted) return;
    replyBox.value = text;
    await submit(text);
  });
  replyBox.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || accepted) return undefined;
    event.preventDefault?.();
    return submit(replyBox.value);
  });
  replyBox.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text');
    if (accepted || typeof text !== 'string') return undefined;
    replyBox.value = text;
    event.preventDefault?.();
    return submit(text);
  });
  cancel.addEventListener('click', () => onCancel());

  setMode(true);
  return {
    element,
    get visible() { return visible; },
    get messageText() { return message.textContent; },
    showHost() {
      accepted = false;
      visible = true;
      element.hidden = false;
      setMode(true);
      inviteText = null;
      setGhosted(copyInvite, true);
      status.textContent = 'Send your friend the invite link, then paste their reply.';
      message.textContent = '';
      replyBox.value = '';
    },
    showJoin() {
      visible = true;
      element.hidden = false;
      setMode(false);
      replyText = null;
      setGhosted(copyReply, true);
      status.textContent = 'Send your reply back to your friend.';
      message.textContent = '';
    },
    setInvite(url) {
      inviteText = url;
      setGhosted(copyInvite, false);
    },
    setReply(text) {
      replyText = text;
      setGhosted(copyReply, false);
    },
    setConnecting() {
      status.textContent = 'Connecting...';
      message.textContent = '';
    },
    showMessage(text) {
      message.textContent = text;
    },
    hide() {
      visible = false;
      element.hidden = true;
    },
  };
}
