// 待機室：部屋番号・招待 URL・参加者。満席になったら卓へ。room_poll を 1.5 秒ごとに読む。
import { configSummary } from '../structure.js';
import { $, app, esc, head, openDlg, toast, clock, inviteUrl, shareInvite, copyText } from './util.js';
import { paint, setPane } from './menu.js';

const POLL_MS = 1500;
let R = null;   // { id, ver, v, timer, ui }

export function enter(id, first) {
  stop();
  R = { id, ver: -1, v: null, timer: 0, ui: 0 };
  if (first?.view) apply(first.view, first.now);
  setPane('room');
  void poll();
  R.ui = setInterval(() => { if (R?.v) render($('#menuIn')); }, 1000);
}
export function stop() { if (!R) { return; } clearTimeout(R.timer); clearInterval(R.ui); R = null; }
export const activeId = () => (R ? R.id : null);

function apply(v, now) {
  if (now) clock.offset = now - Date.now();
  if (!v || v.ver <= R.ver) return;
  R.v = v; R.ver = v.ver;
}

async function poll() {
  const r0 = R; if (!r0) return;
  clearTimeout(r0.timer);
  try {
    const r = await app.net.rpc('room_poll', { p_room: r0.id, p_ver: r0.ver });
    if (R !== r0) return;
    apply(r.view, r.now);
  } catch (e) {
    if (R !== r0) return;
    if (e.code === 'not_found') { stop(); toast('部屋から外れました'); app.nav.toMenu(); return; }
  }
  const v = r0.v;
  if (v && !v.lobby) { stop(); app.nav.enterTable(r0.id); return; }
  if (v?.status === 'cancelled') { stop(); toast('部屋は閉じられました'); app.nav.toMenu(); return; }
  render($('#menuIn'));
  r0.timer = setTimeout(poll, document.hidden ? POLL_MS * 3 : POLL_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && R) void poll(); });

export function render(el) {
  if (!R?.v) return paint(el, '<div class="qbox"><span class="dots" style="justify-content:center;margin:0"><i></i><i></i><i></i></span></div>');
  const v = R.v, rm = v.room, n = rm.config.players, me = app.prof?.nickname;
  const left = Math.max(0, Math.ceil((v.expiresAt - clock.now()) / 1000));
  const slots = Array.from({ length: n }, (_, i) => {
    const name = v.members[i];
    return `<li class="${name ? 'on' : ''}${i === 0 ? ' host' : ''}"><span class="sl-n">${i + 1}</span><span class="sl-name">${name ? esc(name) + (name === me ? ' <em>YOU</em>' : '') : '…'}</span>${i === 0 ? '<span class="sl-tag">HOST</span>' : ''}</li>`;
  }).join('');
  const isHost = v.members[0] === me;
  const url = inviteUrl(rm.code);
  paint(el, `<div class="qbox room-box">
      <div class="q-stake">${rm.kind === 'free' ? 'FREE MATCH' : 'PRIVATE MATCH'}</div>
      <div class="code-big" aria-label="部屋番号"><small>ROOM</small>${esc(rm.code).replace(/(\d{3})(\d{3})/, '$1 $2')}</div>
      <div class="invite"><span class="inv-url">${esc(url)}</span>
        <button class="btn ghost" id="copyUrl" type="button">Copy</button><button class="btn accent" id="shareUrl" type="button">招待</button></div>
      <div class="q-n"><b>${v.members.length}</b> / ${n}</div>
      <ol class="slots">${slots}</ol>
      <div class="cfg-sum">${esc(configSummary(rm.config))}</div>
      <div class="q-exp">${v.members.length < n ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'START'}</div>
      <button class="btn ghost" id="roomLeave" type="button" style="min-height:44px;min-width:160px;flex:none">${isHost ? '部屋を閉じる' : '退出する'}</button>
    </div>`, bind);
}
function bind(el) {
  const v = R.v;
  el.querySelector('#copyUrl').onclick = () => copyText(inviteUrl(v.room.code));
  el.querySelector('#shareUrl').onclick = () => shareInvite(v.room.code, v.room.kind);
  el.querySelector('#roomLeave').onclick = () => askLeave(v.members[0] === app.prof?.nickname);
}
function askLeave(isHost) {
  const r0 = R; if (!r0) return;
  $('#leaveBody').innerHTML = head('LEAVE', isHost ? '部屋を閉じますか？' : '退出しますか？') +
    `<p>${isHost ? '作成者が抜けると部屋は閉じられ、参加者も外れます。' : '待機室から抜けます。'}</p>
    <div class="btns"><button class="btn ghost" data-close type="button">Cancel</button><button class="btn danger" id="leaveOk" type="button">${isHost ? '閉じる' : '退出'}</button></div>`;
  openDlg('#leaveDlg');
  $('#leaveOk').onclick = async () => {
    $('#leaveOk').disabled = true;
    try { await app.net.game({ op: 'leave', room: r0.id }); } catch (e) { /* もう無い部屋なら同じこと */ }
    $('#leaveDlg').close();
    if (R === r0) { stop(); app.nav.toMenu(); }
  };
}
