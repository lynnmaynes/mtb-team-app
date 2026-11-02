/* MTB 12 Team - team pilot of the MTB Fitness 12-week program app (PWA)
 * Fork of the two-person app 2.8.1 (restore point two-person-v2.8.1). Separate link, separate private data repo.
 * Roles from team.json: head coach (sees all athletes), ride lead (own group), athlete (self + optional mutual buddy); admin is a separate switch.
 * Data lives in a private GitHub repo:  program.json, data/<person>.json, data/shared.json
 * Every record keeps a per-field timestamp map (_t) so phones and the PC sync script
 * merge field-by-field: newest edit wins, nothing else is overwritten.
 */
'use strict';
const APP_VERSION = 'team-2.2.0';
const STRAVA_CLIENT_ID = '292465';
const INTRO_VIDEO = 'https://www.youtube.com/watch?v=lclyYasr43Y';
function introCard(full) {   // the booklet asks every new starter to watch this first
  return `<div class="card intro"><h3>▶ Start here: watch the intro video</h3>
    <p class="sub">It answers the 10 most common questions from people following the program.</p>
    <a class="btn block" href="${INTRO_VIDEO}" target="_blank" rel="noopener">Watch on YouTube</a>
    ${full ? '' : `<button class="btn block sec small" data-introdone="1">I've watched it - hide this</button>`}</div>`;
}
const PROGRAM_VERSION = 2;   // program.json with gym plans
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ---------------- storage ---------------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('mtbteam.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mtbteam.' + k, JSON.stringify(v)); } catch (e) { toast('Phone storage full or blocked'); } }
};
let cfg = LS.get('cfg', { owner: '', repo: 'mtb-team-data', token: '', me: '', api: 'https://api.github.com', restSec: 60 });
if (cfg.restOverride === undefined) { cfg = { ...cfg, restOverride: 0 }; delete cfg.restSec; LS.set('cfg', cfg); }   // 2.9: old default rest no longer overrides the program
let P = LS.get('program', null);              // program definition
let D = LS.get('data', {});                   // { lynn:{...}, jarom:{...}, shared:{...} }
let shas = LS.get('shas', {});
let syncState = { busy: false, err: '', last: LS.get('lastSync', 0), dirty: LS.get('dirty', false) };

/* ---- team (team.json, managed by the admin) ---- */
const T_ = () => D.team || {};
const tp = (pid, f) => T_().people?.[pid]?.[f];
const people = () => Object.keys(T_().people || {}).filter(p => tp(p, 'active') !== false && T_().people[p]?.name);
const pname = pid => tp(pid, 'name') || cap(pid);
const roleOf = (pid = me()) => tp(pid, 'role') || 'athlete';          // head | lead | athlete
const isCoach = (pid = me()) => ['head', 'lead'].includes(roleOf(pid));
const isAdmin = (pid = me()) => !!tp(pid, 'admin');
const groupOf = pid => tp(pid, 'group') || '';
const groupName = gid => T_().groups?.[gid]?.name || '';
const groups = (all = false) => Object.keys(T_().groups || {}).filter(g => all || !T_().groups[g].retired);
const me = () => cfg.me;
// a buddy only counts when both people picked each other
const buddyPick = pid => val(pid, 'settings', 'main', 'buddy') || '';
const partner = () => { const b = buddyPick(me()); return b && people().includes(b) && buddyPick(b) === me() ? b : undefined; };
// who a coach can see: head coach = every athlete; ride lead = athletes in their own group; plus coaches who chose to share
function coachSees(pid = me()) {
  if (!isCoach(pid)) return [];
  return people().filter(x => x !== pid && (
    (roleOf(x) === 'athlete' && (roleOf(pid) === 'head' || (groupOf(x) && groupOf(x) === groupOf(pid)))) ||
    (isCoach(x) && val(x, 'settings', 'main', 'shareTraining'))));
}
const sharesGoal = pid => !!val(pid, 'settings', 'main', 'shareGoals');
const sharesAnswers = pid => sharesGoal(pid) && !!val(pid, 'settings', 'main', 'shareAnswers');
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const file = k => (D[k] ||= {});
const rec = (f, coll, key) => D[f]?.[coll]?.[key];
const val = (f, coll, key, field) => rec(f, coll, key)?.[field];

function setVal(f, coll, key, field, value) {
  if (value === '' || value === undefined) value = null;
  const F = file(f); const C = (F[coll] ||= {}); const R = (C[key] ||= { _t: {} });
  R._t ||= {};
  if (JSON.stringify(R[field] ?? null) === JSON.stringify(value)) return;
  R[field] = value; R._t[field] = Date.now();
  LS.set('data', D); syncState.dirty = true; LS.set('dirty', true); paintSync(); scheduleSync();
}

/* ---------------- merge ---------------- */
function mergeRec(a, b) {
  if (!a) return b; if (!b) return a;
  const out = { _t: {} }; const fields = new Set([...Object.keys(a._t || {}), ...Object.keys(b._t || {})]);
  for (const f of fields) {
    const ta = a._t?.[f] ?? -1, tb = b._t?.[f] ?? -1;
    const src = tb > ta ? b : a;
    out[f] = src[f] ?? null; out._t[f] = Math.max(ta, tb);
  }
  return out;
}
function mergeFile(A = {}, B = {}) {
  const out = {};
  for (const coll of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const a = A[coll], b = B[coll];
    if (coll.startsWith('_')) { if (a !== undefined) out[coll] = a; continue; }   // server-computed (_pending, _season): never sent back
    if (typeof (a ?? b) !== 'object' || Array.isArray(a ?? b)) { out[coll] = b ?? a; continue; }
    out[coll] = {};
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) out[coll][k] = mergeRec(a?.[k], b?.[k]);
  }
  return out;
}
const stable = o => JSON.stringify(o, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((r, x) => (r[x] = v[x], r), {}) : v);

/* ---------------- GitHub ---------------- */
const b64enc = s => { const bytes = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
async function gh(method, path, body) {
  const url = `${cfg.api.replace(/\/$/, '')}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
  const r = await fetch(url + (method === 'GET' ? `?t=${Date.now()}` : ''), {
    method, cache: 'no-store',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) { const t = await r.text(); const e = new Error(`GitHub ${r.status}: ${t.slice(0, 140)}`); e.status = r.status; throw e; }
  return r.json();
}
/* ---- phase 2: invite-code sign-in through the relay (no GitHub token on the phone) ---- */
const relayMode = () => !!cfg.key;
let RELAY = cfg.relay || '';
async function relayUrl() {
  if (RELAY) return RELAY;
  const r = await fetch('relay.json', { cache: 'no-store' }); RELAY = (await r.json()).url.replace(/\/$/, ''); return RELAY;
}
let consentGate = null;   // { link } when a parent's permission is needed before syncing
async function relay(method, path, body, auth = true) {
  const r = await fetch(`${await relayUrl()}${path}`, { method, cache: 'no-store',
    headers: { ...(auth && cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || `Relay ${r.status}`); e.status = r.status; Object.assign(e, j);
    if (j.signedOut) { cfg = { ...cfg, key: '', me: '' }; LS.set('cfg', cfg); setTimeout(render, 0); }
    if (j.needConsent) { consentGate = { link: j.link }; setTimeout(render, 0); }
    throw e;
  }
  if (consentGate && auth) { consentGate = null; setTimeout(render, 0); }
  return j;
}
async function ghGetJson(path) {
  if (relayMode()) { try { const j = await relay('GET', `/file?path=${encodeURIComponent(path)}`); return { data: j.data ?? null, sha: j.sha ?? null }; }
    catch (e) { if (e.status === 404) return { data: null, sha: null }; throw e; } }
  const j = await gh('GET', path); if (!j) return { data: null, sha: null };
  let text;
  if (j.content) text = b64dec(j.content);
  else if (j.download_url) text = await (await fetch(j.download_url, { cache: 'no-store', headers: { Authorization: `Bearer ${cfg.token}` } })).text();
  return { data: JSON.parse(text), sha: j.sha };
}
async function ghPutJson(path, data, sha, msg) {
  if (relayMode()) return (await relay('PUT', '/file', { path, data, sha })).sha;
  const j = await gh('PUT', path, { message: msg, content: b64enc(JSON.stringify(data, null, 1)), ...(sha ? { sha } : {}) });
  return j.content.sha;
}

/* ---------------- sync ---------------- */
let syncTimer = null;
function scheduleSync(ms = 3000) { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(), ms); }
async function syncFile(key, writable) {
  const path = key === 'team' ? 'team.json' : `data/${key}.json`;
  if (!writable && relayMode() && key !== 'team') { try { D[key] = (await ghGetJson(path)).data || {}; } catch (e) { if (e.status !== 403) throw e; D[key] = {}; } return; }
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: remote, sha } = await ghGetJson(path);
    const local = D[key] || {};
    const merged = writable ? mergeFile(remote || {}, local) : (remote || {});
    if (writable && stable(merged) !== stable(remote || {})) {
      try {
        shas[key] = await ghPutJson(path, merged, sha, `${me()} phone: update ${key}`);
      } catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
    } else shas[key] = sha;
    D[key] = merged; return;
  }
  throw new Error('Could not save after several tries (someone else was saving). Try again.');
}
async function syncNow(manual) {
  if (!configured()) { if (manual) location.hash = '#settings'; return; }
  if (syncState.busy) return;
  if (!navigator.onLine) { syncState.err = 'Offline - will sync when back online'; paintSync(); return; }
  syncState.busy = true; syncState.err = ''; paintSync();
  const before = stable(D);
  try {
    if (!P || (P.version || 1) < PROGRAM_VERSION) await loadProgram();
    await syncFile('team', isAdmin());
    await syncFile(me(), true);
    const others = new Set(coachSees());
    const b = buddyPick(me()); if (b && b !== me()) others.add(b);
    if (isCoach()) for (const x of people()) if (isCoach(x) && x !== me()) others.add(x);   // to learn who shares their training
    for (const x of others) if (people().includes(x)) await syncFile(x, false);
    if (isAdmin() && !relayMode()) await createMissingFiles();
    await stravaSync();
    LS.set('data', D); LS.set('shas', shas);
    syncState.last = Date.now(); LS.set('lastSync', syncState.last);
    syncState.dirty = false; LS.set('dirty', false);
    if (manual) toast('Synced');
  } catch (e) { syncState.err = e.message; if (manual) toast(e.message); }
  syncState.busy = false; paintSync();
  if (stable(D) !== before) softRender();
}
async function createMissingFiles() {   // admin: give each new team member an empty data file
  const known = new Set(LS.get('files', []));
  for (const x of people()) {
    if (known.has(x) || (D[x] && Object.keys(D[x]).length)) continue;
    const { sha } = await ghGetJson(`data/${x}.json`);
    if (!sha) await ghPutJson(`data/${x}.json`, {}, null, `admin: create ${x}`);
    known.add(x);
  }
  LS.set('files', [...known]);
}
async function loadTeam() {
  const { data } = await ghGetJson('team.json');
  if (!data) throw new Error('team.json not found in the team repo.');
  D.team = data; LS.set('data', D);
}
async function loadProgram() {
  const { data } = await ghGetJson('program.json');
  if (!data) throw new Error('program.json not found in the repo. Run the PC sync script with --init first.');
  P = data; LS.set('program', P);
}
const configured = () => !!cfg.me && (relayMode() || !!(cfg.owner && cfg.repo && cfg.token));

/* ---------------- Strava ----------------
 * The phone never talks to Strava directly. It writes requests into its own data file and pokes
 * strava/kick/<me>.json; a GitHub Action in the data repo does the Strava work and reports back
 * in strava/state.json (read-only here). Garmin creates activities; the app links to them.
 */
let SV = LS.get('strava', null);
const sv = () => SV || {};
const stravaAthlete = (who = me()) => sv().athletes?.[who] || null;
const usesGarmin = (who = me()) => val(who, 'settings', 'main', 'garmin') ?? true;
const tOf = (f, coll, key, field) => rec(f, coll, key)?._t?.[field] || 0;
const stravaConnecting = () => { const t = tOf(me(), 'settings', 'main', 'stravaCode'); return t && t > (sv().handled?.[me()]?.code || 0); };
const stravaDisconnecting = () => { const t = tOf(me(), 'settings', 'main', 'stravaDisconnect'); return val(me(), 'settings', 'main', 'stravaDisconnect') && t > (sv().handled?.[me()]?.disconnect || 0); };
const sState = sid => sv().sessions?.[me()]?.[sid] || null;
const reqPending = sid => { const t = tOf(me(), 'stravaReq', sid, 'action'); return val(me(), 'stravaReq', sid, 'action') && t > (sState(sid)?.reqT || 0); };
function stravaKick(why) { LS.set('kick', why); scheduleSync(800); }
function stravaReq(sid, action) { setVal(me(), 'stravaReq', sid, 'action', null); setVal(me(), 'stravaReq', sid, 'action', action); stravaKick(action); }
async function stravaSync() {
  try { const { data } = await ghGetJson('strava/state.json'); if (data) { SV = data; LS.set('strava', SV); } } catch { }
  const why = LS.get('kick', ''); if (!why) return;
  try {
    const path = `strava/kick/${me()}.json`; const cur = relayMode() ? null : await gh('GET', path);
    await ghPutJson(path, { t: Date.now(), why }, cur?.sha, `${pname(me())} phone: Strava ${why}`);
    LS.set('kick', '');
  } catch (e) { if (!(e.status === 409 || e.status === 422)) throw e; }
}
function stravaAuthUrl() {
  const redirect = location.origin + location.pathname;
  return `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&approval_prompt=auto&scope=read,activity:read_all,activity:write&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(me() || 'x')}`;
}
function stravaAcceptCode(code, scope) {   // code from Strava's redirect (or pasted by hand)
  if (!/activity:write/.test(scope || '') || !/activity:read_all/.test(scope || '')) {
    toast('Please leave all the Strava permission boxes ticked'); return false;
  }
  setVal(me(), 'settings', 'main', 'stravaCode', `${code}|${scope}`); stravaKick('connect'); toast('Connecting to Strava… about a minute'); return true;
}
function handleStravaReturn() {   // runs once at start-up: did Strava just send us back here?
  const q = new URLSearchParams(location.search); if (!q.has('code') && !q.has('error')) return false;
  const code = q.get('code'), scope = q.get('scope') || '', err = q.get('error');
  history.replaceState(null, '', location.pathname + '#settings');
  if (err) { setTimeout(() => toast('Strava connection cancelled'), 300); return false; }
  if (configured()) { stravaAcceptCode(code, scope); return false; }
  // iPhone home-screen apps can come back in a separate Safari window that has no settings - hand the code over by copy/paste
  view().innerHTML = `<h1>Almost connected</h1><div class="card"><p>Strava sent this window back without your app settings (this happens on iPhone).</p>
    <p><b>1.</b> Copy this code: <input id="sc" readonly value="${esc(code + '|' + scope)}"></p><button class="btn block" id="scCopy">Copy code</button>
    <p class="mt"><b>2.</b> Close this window, open <b>MTB 12</b> from your home screen, go to ⚙ → Strava → <b>Paste a code</b>.</p></div>`;
  $('#scCopy').onclick = () => { $('#sc').select(); navigator.clipboard?.writeText($('#sc').value).then(() => toast('Copied'), () => toast('Select the code and copy it')); };
  return true;
}
const stravaLink = id => `<a href="https://www.strava.com/activities/${id}" target="_blank" rel="noopener">View on Strava</a>`;
function stravaStatus(sid) {   // the Strava line on a finished session
  if (!stravaAthlete() || !['Done', 'Partial'].includes(status(me(), sid))) return '';
  const st = sState(sid); const btns = (post = 'Post to Strava') => `<div class="grid2 mt"><button class="btn small strava" data-spost="${sid}">${post}</button><button class="btn small sec" data-sskip="${sid}">Skip</button></div>`;
  let body;
  if (reqPending(sid)) body = `<span class="sub">Sending to Strava… (about a minute)</span>`;
  else if (st?.state === 'linked') body = `✓ On Strava, added to your Garmin activity <b>${esc(st.name || '')}</b> · ${stravaLink(st.id)}`;
  else if (st?.state === 'posted') body = `✓ Posted to Strava · ${stravaLink(st.id)}`;
  else if (st?.state === 'skipped') body = `<span class="sub">Not on Strava (skipped).</span><div class="mt"><button class="btn small sec" data-spost="${sid}">Post to Strava anyway</button></div>`;
  else if (usesGarmin() && st?.state === 'waiting') body = `<span class="sub">Waiting for your Garmin to upload this to Strava - it's checked every hour. Only post it yourself if you didn't record it on the watch.</span>` + btns('Post it myself');
  else body = `<span class="sub">Not on Strava yet.</span>` + btns();
  return `<div class="card stravabox"><h3>Strava</h3><div class="mt">${body}</div></div>`;
}
function stravaPrompts() {   // Today: sessions that still need a Post / Skip decision
  if (!stravaAthlete()) return '';
  const out = [];
  for (const [sid, st] of Object.entries(sv().sessions?.[me()] || {})) {
    if (!['waiting', 'nomatch'].includes(st.state) || reqPending(sid) || !P._sess[sid]) continue;
    if (usesGarmin() && st.state === 'waiting' && Date.now() - (st.waitingSince || 0) < 864e5) continue;   // give the Garmin 24 h
    const s = P._sess[sid];
    out.push(`<div class="card stravabox"><h3>📤 ${s.type === 'HIIT' ? 'HIIT ' + s.n : 'Strength ' + s.n} (week ${s.week}) isn't on Strava</h3>
      <div class="sub">${usesGarmin() ? 'No Garmin activity turned up for ' + fmt(myDate(me(), sid)) + '.' : 'Done ' + fmt(myDate(me(), sid)) + '.'}</div>
      <div class="grid2 mt"><button class="btn small strava" data-spost="${sid}">Post to Strava</button><button class="btn small sec" data-sskip="${sid}">Skip</button></div></div>`);
  }
  return out.join('');
}
function stravaSettings() {
  const a = stravaAthlete(); const err = sv().errors?.[me()];
  let html = `<div class="card"><h3>Strava</h3>`;
  if (stravaDisconnecting()) html += `<p class="sub">Disconnecting… about a minute.</p>`;
  else if (stravaConnecting()) html += `<p class="sub">Connecting… about a minute. This updates on the next sync.</p>`;
  else if (a && !a.needsReconnect) html += `<p>Connected as <b>${esc(a.name || 'Strava athlete')}</b></p>`;
  else html += `<p class="sub">${a?.needsReconnect ? 'Strava access stopped working - connect again.' : 'Connect your own Strava account. Finished workouts are matched to your Garmin uploads (or posted when you tap Post), and outdoor rides are brought into Rides.'}</p>
    <a class="btn block strava" href="${esc(stravaAuthUrl())}">Connect with Strava</a>`;
  if (err) html += `<div class="warnbox">${esc(err)}</div>`;
  html += `<label class="row mt"><input type="checkbox" id="sGarmin" style="width:auto" ${usesGarmin() ? 'checked' : ''}><span>I record workouts on a Garmin (or another watch that uploads to Strava)</span></label>
    <div class="sub">On: the app waits for your watch's upload and adds the details to it. Off: you get a Post to Strava button straight away.</div>`;
  if (a && !stravaDisconnecting()) html += `<button class="btn block sec small" id="sStravaOff">Disconnect Strava</button>`;
  html += `<details class="mt"><summary class="sub">Paste a code (iPhone)</summary><input id="sCode" placeholder="code from the Almost connected page" autocapitalize="off" autocorrect="off"><button class="btn block sec small" id="sCodeGo">Use code</button></details>`;
  if (sv().updated) html += `<p class="sub mt">Strava last checked ${ago(sv().updated).replace('Synced', 'just now')}.</p>`;
  return html + `</div>`;
}

function paintSync() {
  const dot = $('#syncDot'), txt = $('#syncTxt');
  dot.className = syncState.busy ? 'busy' : syncState.err ? 'err' : syncState.dirty ? 'dirty' : syncState.last ? 'ok' : '';
  txt.textContent = syncState.busy ? 'Syncing' : syncState.err ? (syncState.err.startsWith('Offline') ? 'Offline' : 'Retry') : syncState.dirty ? 'Unsaved' : syncState.last ? ago(syncState.last) : 'Sync';
  $('#syncBtn').title = syncState.err || (syncState.last ? 'Last sync ' + new Date(syncState.last).toLocaleString() : 'Sync now');
}
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'Synced' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };

/* ---------------- dates & program helpers ---------------- */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayISO = () => iso(new Date());
const fmt = (s, o = { weekday: 'short', month: 'short', day: 'numeric' }) => s ? parseISO(s).toLocaleDateString(undefined, o) : '';
/* Each person has their own schedule (2.6): a start Monday plus weeks pushed back.
 * settings.main.startDate (any date - snapped to its Monday) and settings.main.push2..push12 = extra weeks inserted before that week. */
const monday = d => { const x = parseISO(d); return iso(addDays(x, -((x.getDay() + 6) % 7))); };
const startISO = (who = me()) => monday(val(who, 'settings', 'main', 'startDate') || T_().settings?.main?.startDate || P.start_date);
const pushAt = (who, w) => +(val(who, 'settings', 'main', 'push' + w) || 0);
const pushedBefore = (who, w) => { let n = 0; for (let k = 2; k <= w; k++) n += pushAt(who, k); return n; };
const weekStart = (w, who = me()) => iso(addDays(parseISO(startISO(who)), (w - 1 + pushedBefore(who, w)) * 7));
const sessDate = (s, who = me()) => iso(addDays(parseISO(weekStart(s.week, who)), s.day_offset));
const progEnd = (who = me()) => iso(addDays(parseISO(weekStart(12, who)), 6));
// 0 = not started, 13 = finished; during a pushed-back (break) week it returns the upcoming week, with brk = true
function weekInfo(who = me(), d = todayISO()) {
  if (d < weekStart(1, who)) return { w: 0 };
  if (d > progEnd(who)) return { w: 13 };
  let w = 1; while (w < 12 && weekStart(w + 1, who) <= d) w++;
  return d > iso(addDays(parseISO(weekStart(w, who)), 6)) ? { w: w + 1, brk: true } : { w };
}
const curWeek = (who = me()) => weekInfo(who).w;
const clampW = w => Math.min(12, Math.max(1, w));
const exById = id => P._ex?.[id];
const plan = id => P._plans?.[id];
const interval = w => P.intervals.find(i => i.week === w);
function prep() {
  if (!P || P._ex) return;
  P._ex = Object.fromEntries(P.exercises.map(e => [e.id, e]));
  P._plans = Object.fromEntries(P.plans.map(p => [p.id, p]));
  P._sess = Object.fromEntries(P.sessions.map(s => [s.id, s]));
}
const isStr = s => s.type === 'Strength' || s.type === 'Bodyweight';
const defTrack = who => val(who, 'settings', 'main', 'defaultTrack') || 'Home';
const where = (who, s) => val(who, 'sessions', s.id, 'where') || defTrack(who);
const COLL = t => t === 'Gym' ? 'gsets' : 'sets';
const tIcon = t => t === 'Gym' ? '🏋️' : '🏠';
const setId = (s, pe, n, t) => t === 'Gym' ? `${s.id}-G-${pe.order}-S${n}` : `${s.id}-${pe.order}-S${n}`;
function setsFor(s, t = 'Home') {
  const out = []; const pl = plan(t === 'Gym' ? s.gym_plan_id : s.plan_id); if (!pl) return out;
  for (const pe of pl.exercises) for (let n = 1; n <= pe.sets; n++) out.push({ id: setId(s, pe, n, t), pe, n });
  return out;
}
const status = (who, sid) => val(who, 'sessions', sid, 'status');
// Each person has their own Date Done / Duration (v2.1). Older data kept one shared value - used only as a fallback.
const myDate = (who, sid) => val(who, 'sessions', sid, 'dateDone') ?? '';
function partnerDateNote(sid) {
  const pt = partner(); if (!pt) return '';
  const d = val(pt, 'sessions', sid, 'dateDone'); const st = status(pt, sid);
  if (!d && !st) return '';
  return `<div class="sub mt">${pname(pt)}: ${st ? esc(st) : 'in progress'}${d ? ' · ' + fmt(d) : ''}</div>`;
}
function chip(who, sid) {
  const st = status(who, sid) || '—'; const s = P._sess[sid];
  return `<span class="chip ${esc(st)} ${who === me() ? 'me' : ''}">${s && isStr(s) ? tIcon(where(who, s)) + ' ' : ''}${esc(pname(who))}: ${esc(st)}</span>`;
}
function setsDone(who, s, t = where(who, s)) { return setsFor(s, t).filter(x => val(who, COLL(t), x.id, 'done')).length; }
function lastTime(who, exid, cur) {   // most recent earlier gym session where this exercise was logged
  const idx = P.sessions.indexOf(cur);
  for (let i = idx - 1; i >= 0; i--) {
    const s = P.sessions[i]; if (!isStr(s)) continue;
    let best = null;
    for (const x of setsFor(s, 'Gym')) {
      if (x.pe.exercise_id !== exid) continue;
      const r = rec(who, 'gsets', x.id); if (!r || (r.weight == null && r.reps == null && r.secs == null)) continue;
      if (!best || (r.weight ?? -1) > (best.weight ?? -1)) best = r;
    }
    if (best) return `${best.weight != null ? best.weight + ' lb' : 'BW'}${best.reps != null ? ' × ' + best.reps : best.secs != null ? ' × ' + best.secs + 's' : ''} <span class="sub">(Wk ${s.week} ${s.suggested_day})</span>`;
  }
  return null;
}
const restTxt = s => !s ? 'none' : ((s >= 60 ? Math.floor(s / 60) + 'm' : '') + (s % 60 ? ' ' + (s % 60) + 's' : '')).trim();
// Book method: exercises with the same letter are done back-to-back as one round (0w = no rest), then rest for the time
// printed on the last one, then back to the first for the next round. The rest timer follows this unless ⚙ overrides it.
const grpOf = (pl, pe) => pl.exercises.filter(e => e.group === pe.group);
const gymCircuit = pl => /Metabolic/.test(pl.kind || '');
// Home and gym circuits always run in rounds; gym Plan 1 / Plan 2 can switch to "By exercise" (remembered per person)
function viewMode(s, t, pl) {
  if (t !== 'Gym' || gymCircuit(pl)) return 'rounds';
  return val(me(), 'settings', 'main', 'gymView') === 'exercise' ? 'exercise' : 'rounds';
}
const groupsOf = pl => { const out = []; for (const pe of pl.exercises) { const g = out[out.length - 1]; if (g && g[0].group === pe.group) g.push(pe); else out.push([pe]); } return out; };
const gRest = g => g[g.length - 1].rest_sec;
const PN = x => pname(x);
const RX = {};   // focus view: rounds the person opened by hand, key "session|track|group" -> Set
function restInfo(pl, pe, mode = 'rounds') {
  const g = grpOf(pl, pe), i = pl.exercises.indexOf(pe), nx = pl.exercises[i + 1];
  if (g.length > 1 && mode === 'exercise') return `rest ${restTxt(gRest(g))} between sets`;
  if (!pe.rest_sec && nx) return `no rest - straight to ${nx.order}`;
  return g.length > 1 ? `rest ${restTxt(pe.rest_sec)} after each round` : `rest ${restTxt(pe.rest_sec)} between sets`;
}
function grpHead(pl, pe) {   // "By exercise" (gym) header for a letter with 2+ exercises
  const g = grpOf(pl, pe); if (g.length < 2 || g[0] !== pe) return '';
  return `<div class="grphead"><b>${esc(pe.group)}: ${g.map(e => e.order).join(', then ')}</b> · all sets of each · rest ${restTxt(gRest(g))} between sets and before the next exercise</div>`;
}
function planExFor(lid) {
  const m = lid.match(/^(.+?-.+?)-(G-)?([A-Z]\d?)-S(\d+)$/); if (!m) return null;
  const s = P._sess[m[1]]; if (!s) return null; const t = m[2] ? 'Gym' : 'Home';
  const pl = plan(m[2] ? s.gym_plan_id : s.plan_id); if (!pl) return null;
  const i = pl.exercises.findIndex(e => e.order === m[3]); return i < 0 ? null : { s, t, pl, pe: pl.exercises[i], i, n: +m[4] };
}
function restForSet(lid) {
  if (cfg.restOverride) return startRest(cfg.restOverride, 'Rest (your ⚙ setting)');
  const x = planExFor(lid); if (!x) return startRest(60);
  const { s, t, pl, pe, i, n } = x, nx = pl.exercises[i + 1], g = grpOf(pl, pe);
  if (g.length > 1 && viewMode(s, t, pl) === 'exercise') return startRest(gRest(g) || 60, n < pe.sets ? `Rest → set ${n + 1}` : (nx ? `Rest → ${nx.order}` : 'Rest'));
  if (!pe.rest_sec && nx) { stopRest(); return toast(`No rest - straight to ${nx.order} ${exById(nx.exercise_id).name}`); }
  const more = n < pe.sets;
  const lbl = more ? (g.length > 1 ? `Rest → round ${n + 1} (${g[0].order})` : `Rest → set ${n + 1}`) : (nx ? `Rest → ${nx.order}` : 'Rest');
  startRest(pe.rest_sec || 60, lbl);
}
const shortRec = r => !r ? '–' : r.weight != null ? `${r.weight}×${r.reps ?? '–'}` : r.secs != null ? `${r.secs}s` : r.reps != null ? `${r.reps}` : (r.done ? '✓' : '–');
const roundSum = (s, g, n, t, who) => g.map(pe => `${pe.order} ${shortRec(rec(who, COLL(t), setId(s, pe, n, t)))}`).join(' · ');
const roundDone = (s, g, n, t) => g.every(pe => rec(me(), COLL(t), setId(s, pe, n, t))?.done);
function roundAdvance(lid) {   // focus view: when a round is finished, fold it and open the next one
  const x = planExFor(lid); if (!x) return; const { s, t, pl, pe, n } = x; const g = grpOf(pl, pe);
  if (g.length < 4 || viewMode(s, t, pl) !== 'rounds' || !roundDone(s, g, n, t)) return;
  RX[`${s.id}|${t}|${g[0].group}`]?.delete(n);
  render(); setTimeout(() => document.getElementById('cur-' + g[0].group)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}
function exHead(s, pl, pe, mode, gym, inRound) {
  const ex = exById(pe.exercise_id); const secs = pe.target_type === 'seconds';
  const nm = ex.video_url ? `<a href="${esc(ex.video_url)}" target="_blank" rel="noopener">${esc(ex.name)}</a>` : esc(ex.name);
  const lt = gym ? lastTime(me(), pe.exercise_id, s) : '';
  return `<h3><span class="sub">${pe.order}</span> ${nm}</h3>
    <div class="meta">${inRound ? '' : pe.sets + ' sets × '}<b>${esc(pe.target)}</b>${pe.per_side ? ' ' + esc(pe.per_side) : ''}${inRound ? '' : ' · ' + restInfo(pl, pe, mode)}${ex.equipment !== 'Bodyweight' ? ' · ' + esc(ex.equipment) : ''}
    ${pe.drop_set ? '<br><b>Triple drop set:</b> log the starting weight and first-drop reps' : ''}
    ${pe.sprint ? '<br>All-out sprint, then carry on with the round.' : ''}
    ${secs && !pe.sprint ? `<button class="timerbtn" data-hold="${pe.target_max || 0}">⏱ ${pe.target_max ? pe.target_max + 's timer' : 'stopwatch'}</button>` : ''}</div>
    ${lt ? `<div class="last">Last time: ${lt}</div>` : ''}`;
}
function setRow(s, pe, n, t, pt, ptSame, label) {
  const gym = t === 'Gym', coll = COLL(t), secs = pe.target_type === 'seconds';
  const lid = setId(s, pe, n, t); const k = `${me()}|${coll}|${lid}`; const r = rec(me(), coll, lid) || {};
  const num = (f, ph) => `<input inputmode="${f === 'weight' ? 'decimal' : 'numeric'}" placeholder="${ph}" data-f="${k}|${f}" data-num value="${esc(r[f] ?? '')}">`;
  let inputs;
  if (pe.sprint) inputs = `<button class="timerbtn sprintbtn" data-sprint="${coll}|${lid}|${pe.target_max}">▶ ${pe.target_max}s sprint</button>${num('secs', 'secs')}`;
  else if (gym) inputs = secs ? `<div class="span2">${num('secs', 'secs')}</div>` : num('weight', 'lb') + num('reps', 'reps');
  else inputs = num(secs ? 'secs' : 'reps', secs ? 'secs' : 'reps') + selectHtml(`${k}|band`, P.band_options, r.band, 'band');
  let h = `<div class="set"><div class="n">${label}</div>${inputs}<button class="done ${r.done ? 'on' : ''}" data-done="${coll}|${lid}">✓</button>`;
  if (ptSame) {
    const q = rec(pt, coll, lid);
    if (q && (q.reps != null || q.secs != null || q.done || q.band || q.weight != null))
      h += `<div class="partner ${pt}">${esc(PN(pt))}: ${q.weight != null ? q.weight + ' lb × ' : ''}${q.reps ?? (q.secs != null ? q.secs + 's' : '–')}${q.band ? ' · ' + esc(q.band) : ''}${q.done ? ' ✓' : ''}</div>`;
  }
  return h + `</div>`;
}
function roundsCard(s, t, pl, g, pt, ptSame) {
  const N = g[0].sets, rest = gRest(g), focus = g.length >= 4, key = `${s.id}|${t}|${g[0].group}`, open = RX[key] || new Set();
  let cur = 0; for (let n = 1; n <= N; n++) if (!roundDone(s, g, n, t)) { cur = n; break; }
  let h = `<div class="card ex rounds"><div class="ghd"><b>${esc(g[0].group)} · ${gymCircuit(pl) && t === 'Gym' ? 'circuit · ' : ''}${N} rounds</b>
    <div class="sub">${g.map(e => e.order).join(' → ')} back-to-back with no rest, then rest ${restTxt(rest)} and start the next round.</div></div>`;
  h += g.map(pe => `<div class="rex">${exHead(s, pl, pe, 'rounds', t === 'Gym', true)}</div>`).join('');
  let folded = false;
  for (let n = 1; n <= N; n++) {
    const done = roundDone(s, g, n, t);
    if (focus && n !== cur && !open.has(n)) {
      if (cur === 0 || n < cur) {
        const ps = ptSame && g.some(pe => rec(pt, COLL(t), setId(s, pe, n, t))) ? roundSum(s, g, n, t, pt) : '';
        h += `<button class="rsum" data-ropen="${key}|${n}"><span>Round ${n} · ${esc(roundSum(s, g, n, t, me()))}${ps ? `<br><span class="partner ${pt}">${esc(PN(pt))}: ${esc(ps)}</span>` : ''}</span><b>${done ? '✓' : ''}</b></button>`;
      } else if (!folded) { folded = true; h += `<button class="rsum next" data-ropen="${key}|${n}">${n < N ? `Rounds ${n}–${N}` : `Round ${n}`} · tap to open</button>`; }
      continue;
    }
    h += `<div class="rnd${focus && n === cur ? ' cur' : ''}"${focus && n === cur ? ` id="cur-${g[0].group}"` : ''}><div class="rt"><span>Round ${n} of ${N}</span>${done ? '<span class="okc">✓ done</span>' : ''}</div>`;
    h += g.map(pe => setRow(s, pe, n, t, pt, ptSame, pe.order)).join('');
    if (n < N) h += `<div class="restline">Rest ${restTxt(rest)}${focus && n === cur ? ` → round ${n + 1}` : ''}</div>`;
    h += `</div>`;
  }
  return h + `</div>`;
}
function sessBody(s, t, pl, pt, ptSame) {
  const mode = viewMode(s, t, pl); let h = '';
  if (t === 'Gym' && !gymCircuit(pl)) h += `<div class="seg mt"><button data-gview="rounds" class="${mode === 'rounds' ? 'on' : ''}">Rounds</button><button data-gview="exercise" class="${mode === 'exercise' ? 'on' : ''}">By exercise</button></div>
    <div class="sub">${mode === 'rounds' ? 'Same-letter exercises back-to-back, then rest after each round.' : "All sets of one exercise, then the next - for when the equipment isn't free or close together. Rest the printed time between sets."}</div>`;
  for (const g of groupsOf(pl)) {
    if (g.length > 1 && mode === 'rounds') { h += roundsCard(s, t, pl, g, pt, ptSame); continue; }
    if (g.length > 1) h += grpHead(pl, g[0]);
    for (const pe of g) {
      h += `<div class="card ex">${exHead(s, pl, pe, mode, t === 'Gym', false)}`;
      for (let n = 1; n <= pe.sets; n++) h += setRow(s, pe, n, t, pt, ptSame, n);
      h += `</div>`;
    }
  }
  return h;
}
function sprintRun(btn) {
  const [coll, lid, sec] = btn.dataset.sprint.split('|');
  if (btn._iv) { clearInterval(btn._iv); btn._iv = null; btn.textContent = `▶ ${sec}s sprint`; wake(false); return; }
  const end = Date.now() + sec * 1000; wake(true); beep(880, .15); stopRest();
  btn._iv = setInterval(() => {
    const left = (end - Date.now()) / 1000; btn.textContent = `■ ${Math.ceil(Math.max(0, left))}s`;
    if (left > 0) return;
    clearInterval(btn._iv); btn._iv = null; beep(1000, .5); vib([300, 100, 300]); wake(false); btn.textContent = `▶ ${sec}s sprint`;
    setVal(me(), coll, lid, 'secs', +sec); markSet(coll, lid);
    if (!val(me(), coll, lid, 'done')) { setVal(me(), coll, lid, 'done', true); markSet(coll, lid); autoDate(lid.split('-').slice(0, 2).join('-')); restForSet(lid); roundAdvance(lid); }
  }, 250);
}
let restWarned = false;
function restOverrideWarn() {
  if (!cfg.restOverride || restWarned) return; restWarned = true;
  const m = document.createElement('div'); m.className = 'modal';
  m.innerHTML = `<div class="mbox"><h3>Rest override is on</h3><p>Your ⚙ rest timer (<b>${cfg.restOverride}s</b> after every set) is overriding the program's recommended rest times.</p>
    <p class="sub">The program: no rest between exercises with the same letter, then the printed rest after each round.</p>
    <button class="btn block" id="mProg">Use the program's rest times</button><button class="btn block sec" id="mKeep">Keep ${cfg.restOverride}s</button></div>`;
  document.body.appendChild(m);
  m.querySelector('#mKeep').onclick = () => m.remove();
  m.querySelector('#mProg').onclick = () => { cfg = { ...cfg, restOverride: 0 }; LS.set('cfg', cfg); m.remove(); toast('Following the program rest times'); };
}
function restSettingHtml() {
  return `<label class="f">Rest timer override (seconds)</label><input id="sRest" inputmode="numeric" placeholder="Blank = follow the program (recommended)" value="${esc(cfg.restOverride || '')}">
   <div class="sub">Leave blank and the rest timer follows the program: no rest between exercises with the same letter, then the printed rest after each round.</div>
   ${cfg.restOverride ? `<div class="warnbox">Override on: ${cfg.restOverride}s after every set, instead of the program's rest times.</div>` : ''}`;
}
function readRestSetting() {   // returns the new override (0 = follow the program); asks before turning an override on or changing it
  const v = Math.max(0, Math.round(+$('#sRest').value || 0));
  if (v && v !== cfg.restOverride && !confirm(`Override the program's rest times?\n\nThe rest timer will run ${v}s after every set, including between exercises with the same letter where the program says no rest (0w).\n\nLeave the box blank to follow the program.`)) return cfg.restOverride || 0;
  return v;
}

/* ---------------- views ---------------- */
const view = () => $('#view');
function header() {
  if (!P) { $('#weekInfo').innerHTML = ''; return; }
  const { w, brk } = weekInfo(); const s = P.sessions.find(x => x.week === clampW(w));
  $('#weekInfo').innerHTML = w === 0 ? `<b>${pname(me())}</b>` : w > 12 ? `<b>Program complete</b><br>${pname(me())}` :
    brk ? `<b>Break week</b><br>Week ${w} next · ${pname(me())}` : `<b>Week ${w}</b> · ${esc(s.phase)}<br>${esc(s.block)} · ${pname(me())}`;
}
function render() {
  prep(); header(); paintSync();
  const [r, a] = (location.hash.slice(1) || 'today').split('/');
  document.querySelectorAll('#tabs a').forEach(x => x.classList.toggle('on', x.dataset.tab === r || (r === 'session' || r === 'hiit') && x.dataset.tab === 'week' || r === 'athlete' && x.dataset.tab === 'team'));
  if (consentGate && configured()) return vConsentGate();
  if (!configured() || !P) { if (r !== 'settings') return vSetup(); }
  const tt = $('#teamTab'); if (tt) tt.hidden = !(configured() && isCoach());
  const v = { today: vToday, week: vWeek, session: vSession, hiit: vHiit, stretch: vStretch, rides: vRides, ride: vRide, progress: vProgress, goals: vGoals, team: vTeam, athlete: vAthlete, settings: vSettings }[r] || vToday;
  v(a);
}
function softRender() {
  const ae = document.activeElement;
  if (ae && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) return; // never yank the field you're typing in
  const y = scrollY; render(); scrollTo(0, y);
}

const SEASON_RE = /^\d{4}-\d{2}$/;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function vSetup() {
  view().innerHTML = `<h1>Welcome 👋</h1>
  <div class="card"><p>MTB 12 Team logs the MTB Fitness 12-week program (home or gym) for our team. Your coaches see your workouts; your goal sheet stays private unless you share it.</p>
  <label class="f">Your invite code (from your coach)</label><input id="jCode" placeholder="ABCD-EFGH" autocapitalize="characters" autocomplete="off">
  <button class="btn block" id="jGo">Continue</button></div>`;
  $('#jGo').onclick = () => { const c = $('#jCode').value.trim(); if (c) vJoin(c); };
}
/* joining with an invite code (+ parent permission for under-18s) */
async function vJoin(code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
  if (isIOS() && !standalone()) {   // iPhone home-screen apps keep their own storage, so join from inside the installed app
    view().innerHTML = `<h1>Install first 📲</h1><div class="card"><p>On iPhone, add MTB 12 Team to your Home Screen first, then join from there:</p>
     <ol><li>Tap the <b>Share</b> button (square with an arrow) at the bottom of Safari.</li><li>Tap <b>Add to Home Screen</b> → <b>Add</b>.</li>
     <li>Open <b>MTB 12 Team</b> from your Home Screen and enter this code:</li></ol><div class="bigcode">${esc(code)}</div></div>`;
    return;
  }
  view().innerHTML = `<h1>Joining…</h1><div class="card sub">Checking your invite code.</div>`;
  let info;
  try { info = await relay('POST', '/join/check', { code }, false); }
  catch (e) { view().innerHTML = `<h1>Hmm…</h1><div class="card"><p>${esc(e.message)}</p><a class="btn block sec" href="#">Try another code</a></div>`; return; }
  const who = `<div class="card"><h3>Welcome, ${esc(info.name)}!</h3><div class="sub">${esc(info.role)}${info.group ? ' · ' + esc(info.group) : ''}${info.team ? ' · ' + esc(info.team) : ''}</div></div>`;
  if (info.consentNeeded) {
    view().innerHTML = `<h1>Ask a parent</h1>${who}${parentAskCard(info.link, info.name)}
      <button class="btn block" id="jRetry">I've got permission - continue</button>`;
    wireParentAsk(info.link, info.name); $('#jRetry').onclick = () => vJoin(code); return;
  }
  view().innerHTML = `<h1>Ready to go</h1>${who}<div class="card sub">Your coach${info.role === 'Athlete' ? ' (ride lead and head coach)' : 'es'} can see the workouts you log here. Your goal sheet stays private unless you choose to share it.</div>
    <button class="btn block" id="jJoin">Join the team</button>`;
  $('#jJoin').onclick = async () => {
    try {
      const j = await relay('POST', '/join', { code }, false);
      cfg = { ...cfg, key: j.key, me: j.pid, relay: await relayUrl(), owner: '', token: '' }; LS.set('cfg', cfg);
      D = {}; shas = {}; LS.set('data', D); history.replaceState(null, '', location.pathname + '#today');
      toast(`Welcome, ${j.name}!`); await syncNow(true); render();
      if (!standalone() && !isIOS()) toast('Tip: ⋮ menu → Add to Home screen');
    } catch (e) { toast(e.message); if (e.needConsent) vJoin(code); }
  };
}
function parentAskCard(link, name) {
  return `<div class="card"><p>Because you're under 18, a parent or guardian needs to say it's OK${name ? '' : ''} before you can use the app${consentGate ? ' this season' : ''}.</p>
   <p class="sub">Send them this link. They'll see what the app records and who can see it, and can approve it on their own phone or computer.</p>
   <button class="btn block" id="pSend">Send to parent</button><input class="mt" id="pLink" readonly value="${esc(link)}"></div>`;
}
function wireParentAsk(link, name) {
  $('#pSend').onclick = async () => {
    const text = `Hi! Can you give permission for ${name || 'me'} to use the MTB 12 Team training app? It takes a minute:`;
    if (navigator.share) { try { await navigator.share({ title: 'MTB 12 Team - permission', text, url: link }); return; } catch { } }
    try { await navigator.clipboard.writeText(`${text} ${link}`); toast('Link copied - paste it into a text to your parent'); } catch { $('#pLink').select(); toast('Copy the link below'); }
  };
}
function vConsentGate() {
  view().innerHTML = `<h1>Permission needed</h1><div class="card"><p>It's a new season - a parent or guardian needs to give permission again before your training syncs.</p></div>
    ${parentAskCard(consentGate.link, pname(me()))}<button class="btn block" id="pCheck">Check again</button>`;
  wireParentAsk(consentGate.link, pname(me())); $('#pCheck').onclick = () => syncNow(true);
}

function sessionCard(s, opts = {}) {
  const d = sessDate(s); const isT = d === todayISO();
  const href = s.type === 'HIIT' ? `#hiit/${s.id}` : `#session/${s.id}`;
  let extra = '';
  const mt = isStr(s) ? where(me(), s) : null;
  if (mt) { const tot = setsFor(s, mt).length; extra = `<span class="sub"> · ${setsDone(me(), s)}/${tot} sets</span>`; }
  else { const iv = interval(s.week); extra = `<span class="sub"> · ${iv.reps}× ${iv.work_sec}s/${iv.rest_sec}s</span>`; }
  return `<a class="card sess ${isT ? 'today' : ''}" href="${href}">
    <div class="day d-${s.suggested_day}">${s.suggested_day}<small>${fmt(d, { month: 'numeric', day: 'numeric' })}</small></div>
    <div class="grow"><h3>${s.type === 'HIIT' ? 'HIIT ' + s.n + ' · ' + esc(interval(s.week).focus) : tIcon(mt) + ' Strength ' + s.n + ' of 3'}</h3>
    <div class="sub">${esc(s.type === 'HIIT' ? 'Gym bike / elliptical' : mt === 'Gym' ? s.gym_label : s.label)}${extra}</div>
    <div>${chip(me(), s.id)}${partner() ? chip(partner(), s.id) : ''}</div></div></a>`;
}
function vToday() {
  const t = todayISO(); const { w, brk } = weekInfo();
  const todays = P.sessions.filter(s => sessDate(s) === t);
  const dow = DAYS[(new Date().getDay() + 6) % 7];
  let html = `<h1>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h1>`;
  if (!val(me(), 'settings', 'main', 'introWatched')) html += introCard(false);
  html += stravaPrompts();
  if (w === 0) html += `<div class="card">Your program starts <b>${fmt(startISO(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</b> (${Math.ceil((parseISO(startISO()) - parseISO(t)) / 864e5)} days). Preview week 1 below.
    <div class="mt"><a href="#settings/schedule">Change my start date</a></div></div>`;
  if (brk) html += `<div class="card"><h3>Break week 🌴</h3><div class="sub">You pushed your schedule back. Week ${w} starts ${fmt(weekStart(w), { weekday: 'long', month: 'short', day: 'numeric' })}.</div></div>`;
  if (w > 12) html += `<div class="card">🎉 12 weeks done. Check <a href="#progress">Progress</a>.</div>`;
  if (todays.length) html += `<h2>Today's workout</h2>` + todays.map(s => sessionCard(s)).join('');
  else if (w >= 1 && w <= 12 && !brk) html += `<div class="card"><h3>${dow === 'Thu' || dow === 'Sun' ? 'Rest day 😴' : 'No session scheduled'}</h3><div class="sub">Catch up on a missed session from this week if needed.</div></div>`;
  if (dow === 'Sat' && w >= 1 && w <= 12 && !brk) html += rideCard(t);   // Saturday = MTB ride day (plus Strength 3)
  // stretches today
  const sd = t;
  html += `<h2>Daily stretches</h2>${stretchSummary(sd)}`;
  const wk = clampW(w || 1);
  html += `<h2>Week ${wk}</h2>` + P.sessions.filter(s => s.week === wk && !todays.includes(s)).map(s => sessionCard(s)).join('');
  view().innerHTML = html;
}
function stretchSummary(d) {
  const n = who => (val(who, 'stretch', d, 's') || []).filter(Boolean).length;
  return `<a class="card sess" href="#stretch/${d}"><div class="day d-${DAYS[(parseISO(d).getDay() + 6) % 7]}">🧘<small>${fmt(d, { month: 'numeric', day: 'numeric' })}</small></div>
   <div class="grow"><h3>9 correctives · 1×10 each</h3><div><span class="chip ${n(me()) === 9 ? 'Done' : ''} me">${pname(me())}: ${n(me())}/9</span>${partner() ? `<span class="chip ${n(partner()) === 9 ? 'Done' : ''}">${pname(partner())}: ${n(partner())}/9</span>` : ''}</div></div></a>`;
}
function vWeek(a) {
  const w = clampW(+a || curWeek() || 1);
  const s0 = P.sessions.find(s => s.week === w);
  view().innerHTML = `<div class="row"><a class="btn sec small" href="#week/${w - 1}" ${w <= 1 ? 'style="visibility:hidden"' : ''}>‹</a>
    <div class="grow center"><h1>Week ${w}</h1><div class="sub">${fmt(weekStart(w))} – ${fmt(iso(addDays(parseISO(weekStart(w)), 6)))} · ${esc(s0.phase)} · ${esc(s0.block)}</div></div>
    <a class="btn sec small" href="#week/${w + 1}" ${w >= 12 ? 'style="visibility:hidden"' : ''}>›</a></div>` +
    weekPlan(w);
}
// Week layout: Mon Str1 · Tue HIIT1 · Wed Str2 · Thu Rest · Fri HIIT2 · Sat Str3 + MTB ride · Sun Rest
const restCard = d => `<div class="card sess"><div class="day d-${DAYS[(parseISO(d).getDay() + 6) % 7]}">${DAYS[(parseISO(d).getDay() + 6) % 7]}<small>${fmt(d, { month: 'numeric', day: 'numeric' })}</small></div><div class="grow"><h3>Rest</h3></div></div>`;
const rideCard = d => `<a class="card sess" href="#ride/new"><div class="day d-Sat">Sat<small>${fmt(d, { month: 'numeric', day: 'numeric' })}</small></div><div class="grow"><h3>🚵 MTB ride</h3><div class="sub">Tap to log your ride</div></div></a>`;
function weekPlan(w) {
  const day = off => iso(addDays(parseISO(weekStart(w)), off));
  const ss = P.sessions.filter(s => s.week === w);
  const at = off => ss.filter(s => s.day_offset === off).map(s => sessionCard(s)).join('');
  return at(0) + at(1) + at(2) + restCard(day(3)) + at(4) + at(5) + rideCard(day(5)) + restCard(day(6));
}

/* ----- strength session (home or gym) ----- */
function vSession(id) {
  const s = P._sess[id]; if (!s) return vToday();
  const t = where(me(), s), gym = t === 'Gym', coll = COLL(t);
  const pl = plan(gym ? s.gym_plan_id : s.plan_id); const pt = partner(); const ptSame = pt && where(pt, s) === t;
  let html = `<a href="#week/${s.week}" class="sub">‹ Week ${s.week}</a>
  <h1>Strength ${s.n} of 3</h1><div class="sub">${esc(gym ? s.gym_label : s.label)} · suggested ${fmt(sessDate(s))}</div>
  <div class="seg mt"><button data-where="${id}|Home" class="${gym ? '' : 'on'}">🏠 Home</button><button data-where="${id}|Gym" class="${gym ? 'on' : ''}">🏋️ Gym</button></div>
  ${pt && !ptSame ? `<div class="sub mt">${pname(pt)} is doing this one at ${where(pt, s) === 'Gym' ? 'the gym' : 'home'}.</div>` : ''}
  <div class="card grid2">
    <div><label class="f">My date done</label><input type="date" data-f="${me()}|sessions|${id}|dateDone" value="${esc(myDate(me(), id))}"></div>
    <div><label class="f">My status</label>${selectHtml(`${me()}|sessions|${id}|status`, P.status_options, status(me(), id))}</div>
  </div>${partnerDateNote(id)}`;
  html += sessBody(s, t, pl, pt, ptSame);
  html += `<div class="card"><div class="grid2">
    <div><label class="f">My duration (min)</label><input inputmode="numeric" data-num data-f="${me()}|sessions|${id}|duration" value="${esc(val(me(), 'sessions', id, 'duration') ?? '')}"></div>
    <div><label class="f">My RPE (1-10)</label>${selectHtml(`${me()}|sessions|${id}|rpe`, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], val(me(), 'sessions', id, 'rpe'))}</div></div>
    <label class="f">Session notes</label><textarea data-f="${me()}|sessions|${id}|notes">${esc(val(me(), 'sessions', id, 'notes') || '')}</textarea>
    <button class="btn block" data-finish="${id}">Finish workout ✓</button></div>${stravaStatus(id)}`;
  view().innerHTML = html; paintT(); restOverrideWarn();
}
function markSet(coll, lid) { const b = document.querySelector(`[data-done="${coll}|${lid}"]`); if (b) b.classList.add('on'); const i = document.querySelector(`[data-f="${me()}|${coll}|${lid}|secs"]`); if (i) i.value = val(me(), coll, lid, 'secs') ?? ''; }
function selectHtml(key, opts, cur, ph) {
  return `<select data-f="${key}"><option value="">${ph || '–'}</option>${opts.map(o => `<option ${String(o) === String(cur ?? '') ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}

/* ----- HIIT ----- */
function vHiit(id) {
  const s = P._sess[id]; if (!s) return vToday();
  const iv = interval(s.week); const k = `${me()}|hiit|${id}`; const v = f => esc(val(me(), 'hiit', id, f) ?? '');
  const pt = partner(); const pr = pt && rec(pt, 'hiit', id);
  view().innerHTML = `<a href="#week/${s.week}" class="sub">‹ Week ${s.week}</a>
  <h1>HIIT ${s.n} · ${esc(iv.focus)}</h1><div class="sub">Week ${s.week} · suggested ${fmt(sessDate(s))}</div>
  <div class="card"><b>${iv.reps} × ${iv.work_sec}s work / ${iv.rest_sec}s rest</b> · target ${esc(iv.target_rpm)} (bike)<div class="sub mt">${esc(iv.how_to)}</div>
  <div class="sub">On the elliptical, match the effort and track the resistance level.</div></div>
  ${warmPicker('hbox-' + id)}
  ${timerBox('hbox-' + id, iv.reps, iv.work_sec)}
  ${val(me(), 'hiit', id, 'warmupMin') != null || val(me(), 'hiit', id, 'cooldownMin') != null ? `<div class="sub center mt">Last time: ${val(me(), 'hiit', id, 'warmupMin') ?? 0} min warm-up · ${val(me(), 'hiit', id, 'cooldownMin') ?? 0} min cool-down</div>` : ''}
  <div class="card">
   <div class="grid2"><div><label class="f">My date done</label><input type="date" data-f="${me()}|sessions|${id}|dateDone" value="${esc(myDate(me(), id))}"></div>
   <div><label class="f">My status</label>${selectHtml(`${me()}|sessions|${id}|status`, P.status_options, status(me(), id))}</div></div>
   <div class="grid2"><div><label class="f">Machine</label>${selectHtml(`${k}|machine`, P.machine_options, val(me(), 'hiit', id, 'machine'))}</div>
   <div><label class="f">Intervals completed</label><input inputmode="numeric" data-num id="hcomp" data-f="${k}|intervals" value="${v('intervals')}"></div></div>
   <div class="grid3"><div><label class="f">Work resist.</label><input inputmode="decimal" data-num data-f="${k}|workRes" value="${v('workRes')}"></div>
   <div><label class="f">Rest resist.</label><input inputmode="decimal" data-num data-f="${k}|restRes" value="${v('restRes')}"></div>
   <div><label class="f">Avg RPM/SPM</label><input inputmode="numeric" data-num data-f="${k}|avgRpm" value="${v('avgRpm')}"></div></div>
   <div class="grid3"><div><label class="f">Avg HR</label><input inputmode="numeric" data-num data-f="${k}|avgHr" value="${v('avgHr')}"></div>
   <div><label class="f">Max HR</label><input inputmode="numeric" data-num data-f="${k}|maxHr" value="${v('maxHr')}"></div>
   <div><label class="f">RPE</label>${selectHtml(`${k}|rpe`, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], val(me(), 'hiit', id, 'rpe'))}</div></div>
   <label class="f">My total time (min)</label><input inputmode="numeric" data-num data-f="${k}|totalTime" value="${esc(val(me(), 'hiit', id, 'totalTime') ?? '')}">
   <label class="f">Notes</label><textarea data-f="${me()}|hiit|${id}|notes">${esc(val(me(), 'hiit', id, 'notes') || '')}</textarea>
   ${pr ? `<div class="partner ${pt} mt">${pname(pt)}: ${esc(pr.machine || '')} ${pr.intervals != null ? pr.intervals + '/' + iv.reps + ' intervals' : ''} ${pr.avgHr ? '· avg HR ' + pr.avgHr : ''}</div>` : ''}
   <button class="btn block" data-finish="${id}">Finish HIIT ✓</button></div>${stravaStatus(id)}`;
  const saveIntervals = done => { const cur = val(me(), 'hiit', id, 'intervals'); if (done && (cur == null || cur < done)) setVal(me(), 'hiit', id, 'intervals', done); const c = $('#hcomp'); if (c) c.value = val(me(), 'hiit', id, 'intervals') ?? ''; };
  TCFG['hbox-' + id] = { reps: iv.reps, work: iv.work_sec, rest: iv.rest_sec, warm: true, cool: COOLDOWN_SEC,
    onLastWork: saveIntervals,   // recorded the moment the last interval ends, not after the cool-down
    onEnd: (done, t) => {
      saveIntervals(done);
      if (t.warmSec || t.coolSec) { setVal(me(), 'hiit', id, 'warmupMin', Math.round(t.warmSec / 60)); setVal(me(), 'hiit', id, 'cooldownMin', Math.round(t.coolSec / 60)); }
      if (val(me(), 'hiit', id, 'totalTime') == null && t.activeSec >= 60) {   // fill "My total time" from the timer, only if empty
        setVal(me(), 'hiit', id, 'totalTime', Math.round(t.activeSec / 60));
        const i = document.querySelector(`[data-f="${me()}|hiit|${id}|totalTime"]`); if (i) i.value = val(me(), 'hiit', id, 'totalTime');
      }
    } };
  paintT();
}
const clock = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };

/* ----- interval timer (HIIT + gym bike sprints) -----
 * Clock-based: phases end at absolute times, so the timer stays correct even if the phone
 * sleeps or the browser throttles it - when you come back it catches up to the right phase. */
const TCFG = {};   // box id -> {reps, work, rest, warm?, cool?, onWork(i), onLastWork(n), onEnd(completed, times)}
const COOLDOWN_SEC = 300;                                  // fixed 5-minute cool-down after the last HIIT interval
const warmMin = () => val(me(), 'settings', 'main', 'warmupMin') ?? 3;   // remembered per person; 3 min the first time
function warmPicker(box) {
  if (T && !T.done && T.box === box) return '';
  const cur = warmMin();
  return `<div class="card"><label class="f">Warm-up before the first interval</label>
   <div class="seg wseg">${[0, 1, 2, 3, 4, 5].map(n => `<button data-warm="${n}" class="${cur === n ? 'on' : ''}">${n ? n + ' min' : 'Skip'}</button>`).join('')}</div>
   <div class="sub mt">You can cut it short any time. A 5-minute cool-down follows the last interval (skippable).</div></div>`;
}
let T = null;
function timerBox(box, reps, work) {
  return `<div class="hiitbox" id="${box}"><div class="phase">READY</div><div class="big">${clock(work)}</div>
   <div class="center sub rep">Interval 0 of ${reps}</div>
   <div class="grid3 mt"><button class="btn" data-tstart="${box}">Start</button><button class="btn sec" data-tpause="${box}">Pause</button><button class="btn sec" data-tstop="${box}">Stop</button></div>
   <button class="btn block tskip" data-tskip="${box}" hidden></button></div>`;
}
function startT(box) {
  const c = TCFG[box]; if (!c) return;
  if (T && !T.done) { if (T.box !== box) toast('Another timer is running'); return; }
  const now = Date.now(); const warm = c.warm ? warmMin() * 60 : 0;
  T = { box, ...c, rep: warm ? 0 : 1, phase: warm ? 'WARMUP' : 'WORK', end: now + (warm || c.work) * 1000, paused: 0, done: false, completed: 0, lastBeep: -1,
        t0: now, pausedMs: 0, pausedAt: 0, warmStart: now, warmSec: 0, coolStart: 0, coolSec: 0 };
  beep(880, .25); vib(300); wake(true);
  const pk = document.querySelector('.wseg'); if (pk) pk.closest('.card').remove();
  T.iv = setInterval(tickT, 200); paintT();
}
function tickT() {
  if (!T || T.done || T.paused) return;
  while (Date.now() >= T.end && !T.done) {
    if (T.phase === 'WARMUP') {
      T.warmSec = (T.end - T.warmStart - T.pausedMs) / 1000;
      T.rep = 1; T.phase = 'WORK'; T.end += T.work * 1000; beep(880, .4); vib(400);
    } else if (T.phase === 'WORK') {
      T.completed = T.rep; T.onWork?.(T.rep);
      if (T.rep >= T.reps) {
        T.onLastWork?.(T.completed);
        if (!T.cool) { endT(false); return; }
        T.phase = 'COOLDOWN'; T.coolStart = T.end; T.end += T.cool * 1000; beep(1000, .5); vib([300, 100, 300]);
      } else { T.phase = 'REST'; T.end += T.rest * 1000; beep(440, .4); vib([200, 100, 200]); }
    } else if (T.phase === 'COOLDOWN') { T.coolSec = T.cool; T.end = T.coolStart + T.cool * 1000; endT(false); return;
    } else { T.rep++; T.phase = 'WORK'; T.end += T.work * 1000; beep(880, .4); vib(400); }
    T.lastBeep = -1;
  }
  const sec = Math.ceil((T.end - Date.now()) / 1000);
  if (sec <= 3 && sec > 0 && sec !== T.lastBeep) { T.lastBeep = sec; beep(660, .08); }
  paintT();
}
function pauseT(box) {
  if (!T || T.done || T.box !== box) return;
  if (T.paused) { T.end = Date.now() + T.paused; T.paused = 0; T.pausedMs += Date.now() - T.pausedAt; } else { T.paused = Math.max(1, T.end - Date.now()); T.pausedAt = Date.now(); }
  paintT();
}
function skipT(box) {   // warm-up: 3-2-1 lead-in to the first interval; cool-down: finish now
  if (!T || T.done || T.box !== box) return;
  if (T.paused) pauseT(box);
  if (T.phase === 'WARMUP') { const lead = Date.now() + 3000; if (T.end > lead) T.end = lead; T.lastBeep = -1; tickT(); }
  else if (T.phase === 'COOLDOWN') { T.coolSec = (Date.now() - T.coolStart) / 1000; endT(false); }
}
function endT(stopped) {
  if (!T || T.done) return; clearInterval(T.iv);
  const now = Date.now(); if (T.paused) T.pausedMs += now - T.pausedAt;
  if (T.phase === 'WARMUP') T.warmSec = (now - T.warmStart - T.pausedMs) / 1000;
  if (T.phase === 'COOLDOWN' && stopped) T.coolSec = (now - T.coolStart) / 1000;
  const activeSec = Math.max(0, (Math.min(now, T.phase === 'COOLDOWN' && !stopped ? T.coolStart + T.coolSec * 1000 : now) - T.t0 - T.pausedMs) / 1000);
  T.done = true; T.phase = stopped ? 'STOPPED' : 'DONE'; wake(false);
  if (!stopped) { beep(1000, .6); vib([300, 100, 300, 100, 600]); }
  T.onEnd?.(T.completed, { warmSec: T.warmSec, coolSec: T.coolSec, activeSec }); paintT();
}
function paintT() {
  if (!T) return; const box = document.getElementById(T.box); if (!box) return;
  const left = T.done ? 0 : T.paused ? T.paused / 1000 : (T.end - Date.now()) / 1000;
  box.className = 'hiitbox ' + T.phase;
  const ph = box.querySelector('.phase'); ph.className = 'phase ' + T.phase;
  ph.textContent = T.phase === 'DONE' ? 'DONE 🎉' : T.paused ? 'PAUSED' : { WARMUP: 'WARM-UP', COOLDOWN: 'COOL-DOWN' }[T.phase] || T.phase;
  box.querySelector('.big').textContent = clock(left);
  box.querySelector('.rep').textContent = T.phase === 'WARMUP' ? `Easy spin · then ${T.reps} intervals` : T.phase === 'COOLDOWN' ? `All ${T.reps} intervals done · easy spin` : `Interval ${T.done ? T.completed : T.rep} of ${T.reps}`;
  const sk = box.querySelector('[data-tskip]');
  if (sk) { const lead = T.phase === 'WARMUP' && T.end - Date.now() <= 3100; sk.hidden = T.done || !['WARMUP', 'COOLDOWN'].includes(T.phase) || lead;
    sk.textContent = T.phase === 'WARMUP' ? "I'm warm - start intervals ▶" : 'Skip cool-down'; }
  box.querySelector('[data-tpause]').textContent = T.paused ? 'Resume' : 'Pause';
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tickT(); });

/* ----- stretches ----- */
function vStretch(d) {
  const w = curWeek();
  d = d || todayISO();   // stretches are logged on the day you actually do them
  const arr = val(me(), 'stretch', d, 's') || Array(9).fill(false);
  const parr = partner() ? (val(partner(), 'stretch', d, 's') || []) : [];
  const ids = P.stretches.exercise_ids;
  view().innerHTML = `<div class="row"><a class="btn sec small" href="#stretch/${iso(addDays(parseISO(d), -1))}">‹</a>
   <div class="grow center"><h1>Stretches</h1><div class="sub">${d === todayISO() ? 'Today · ' : ''}${fmt(d, { weekday: 'long', month: 'short', day: 'numeric' })}${d !== todayISO() ? ` · <a href="#stretch/${todayISO()}">Back to today</a>` : ''}</div></div>
   <a class="btn sec small" href="#stretch/${iso(addDays(parseISO(d), 1))}" ${d >= todayISO() ? 'style="visibility:hidden"' : ''}>›</a></div>
   <div class="card">${ids.map((id, i) => `<div class="stretch"><a href="${esc(exById(id).video_url)}" target="_blank" rel="noopener">${esc(P.stretches.names[i])}<div class="sub">1 × 10${parr[i] ? ` · <span style="color:var(--jarom)">${pname(partner())} ✓</span>` : ''}</div></a>
     <button class="done ${arr[i] ? 'on' : ''}" style="width:52px" data-stretch="${d}|${i}">✓</button></div>`).join('')}
   <button class="btn block sec" data-stretchall="${d}">Mark all 9 done</button>
   <label class="f">Notes</label><textarea data-f="${me()}|stretchNotes|${d}|notes">${esc(val(me(), 'stretchNotes', d, 'notes') || '')}</textarea></div>`;
}

/* ----- rides ----- */
function rides(who = me()) { return Object.entries(D[who]?.rides || {}).filter(([, r]) => !r.deleted && r.date).sort((a, b) => b[1].date.localeCompare(a[1].date)); }
function vRides() {
  const list = rides();
  view().innerHTML = `<h1>MTB Rides</h1><a class="btn block" href="#ride/new">+ Log a ride</a>
   ${list.length ? list.map(([id, r]) => `<a class="card sess" href="#ride/${id}"><div class="day d-Sun">${fmt(r.date, { month: 'numeric', day: 'numeric' })}</div>
     <div class="grow"><h3>${esc(r.route || 'Ride')}</h3><div class="sub">${r.with ? 'with ' + esc(r.with) + ' · ' : ''}${r.miles ?? '–'} mi · ${r.elev ?? '–'} ft · ${r.time ?? '–'} min${r.stravaIds ? ' · <span class="stag">Strava</span>' : ''}</div></div></a>`).join('') : '<p class="sub center mt">No rides logged yet.</p>'}`;
}
// A new ride is only a draft until you type something - backing out leaves nothing behind (2.5.1)
let rideDraft = null;   // { id, date, rider } defaults shown on the form but not saved yet
function saveRideDraft(id) {
  if (!rideDraft || rideDraft.id !== id || rec(me(), 'rides', id)) return;
  const d = rideDraft; rideDraft = null;
  setVal(me(), 'rides', id, 'date', d.date);
}
function vRide(id) {
  if (id === 'new') { id = `R-${Date.now().toString(36)}-${me()}`; rideDraft = { id, date: todayISO(), rider: pname(me()) }; history.replaceState(null, '', '#ride/' + id); }
  const draft = rideDraft?.id === id && !rec(me(), 'rides', id) ? rideDraft : null;
  const rv_ = f => val(me(), 'rides', id, f) ?? (draft ? draft[f] : undefined);
  const k = `${me()}|rides|${id}`; const v = f => esc(rv_(f) ?? '');
  view().innerHTML = `<a href="#rides" class="sub">‹ Rides</a><h1>Ride</h1><div class="card">
   <div class="grid2"><div><label class="f">Date</label><input type="date" data-f="${k}|date" value="${v('date')}"></div>
   <div><label class="f">Rode with (optional)</label><input data-f="${k}|with" value="${v('with')}"></div></div>
   <label class="f">Trail / route</label><input data-f="${k}|route" value="${v('route')}">
   <div class="grid3"><div><label class="f">Miles</label><input inputmode="decimal" data-num data-f="${k}|miles" value="${v('miles')}"></div>
   <div><label class="f">Elev gain ft</label><input inputmode="numeric" data-num data-f="${k}|elev" value="${v('elev')}"></div>
   <div><label class="f">Moving min</label><input inputmode="numeric" data-num data-f="${k}|time" value="${v('time')}"></div></div>
   <div class="grid3"><div><label class="f">Avg HR</label><input inputmode="numeric" data-num data-f="${k}|avgHr" value="${v('avgHr')}"></div>
   <div><label class="f">Max HR</label><input inputmode="numeric" data-num data-f="${k}|maxHr" value="${v('maxHr')}"></div>
   <div><label class="f">RPE</label>${selectHtml(`${k}|rpe`, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], val(me(), 'rides', id, 'rpe'))}</div></div>
   <label class="f">Notes</label><textarea data-f="${k}|notes">${v('notes')}</textarea>
   ${val(me(), 'rides', id, 'stravaIds') ? `<div class="sub mt">Imported from Strava · ${String(val(me(), 'rides', id, 'stravaIds')).split(',').map(stravaLink).join(' · ')}</div>` : ''}
   <a class="btn block" href="#rides">Save</a><button class="btn block danger" data-delride="${id}">Delete ride</button></div>`;
}

/* ----- goals (booklet pp. 6-13: SMART goal setting sheet) - synced with the Excel Goals tab ----- */
const GOAL_QS = [
  ['q1', 'What do you want to achieve with your mountain biking?', 'e.g. "Under 3 minutes on my local Strava hill climb before my birthday on 4 August" - specific, measurable, with a date.'],
  ['q2', 'Why do you want to achieve this?', 'Be as detailed as possible - "because I want to feel fit" doesn\'t cut it. Go deeper.'],
  ['q3', 'When you achieve your goal, how will it make you feel?', 'The more you can visualise achieving it, the better.'],
  ['q4', "If you don't achieve it, what will the consequences be?", 'How will it negatively affect you and your life? How would that feel?'],
  ['q5', 'Right now, where do you feel you are in relation to your goal?', ''],
  ['q6', 'Detail the steps you need to take to achieve your goal.', ''],
  ['q7', 'What are potential stumbling blocks that could halt or hinder your progress?', 'Maybe times in the past when you did well and fell off the wagon?'],
  ['q8', "How can you solve these stumbling blocks so they don't stop your progress?", ''],
  ['q9', 'Out of 10, how much effort are you willing to put in?', '']];
const N_MINI = 6;
function vGoals(a) {
  const who = a === 'partner' && partner() ? partner() : a && a !== 'partner' && coachSees().includes(a) ? a : me(); const mine = who === me();
  const canQ1 = mine || who === partner() || sharesGoal(who), canAns = mine || who === partner() || sharesAnswers(who);
  const g = f => val(who, 'goals', 'main', f); const k = f => `${who}|goals|main|${f}`;
  const ro = mine ? '' : 'disabled';
  let html = `<h1>🎯 Goals</h1>
   ${partner() ? `<div class="seg"><button data-goalswho="" class="${mine ? 'on' : ''}">Mine</button><button data-goalswho="partner" class="${mine ? '' : 'on'}">${pname(partner())}'s</button></div>` : ''}
   ${!mine && !canQ1 ? `<div class="card sub">${esc(pname(who))} hasn't shared their goals.</div>` : ''}
   ${mine ? `<div class="card"><h3>Sharing with my coaches</h3>
     <label class="row mt"><input type="checkbox" id="gShare" style="width:auto" ${sharesGoal(me()) ? 'checked' : ''}><span>Share my goal and progress (goal, deadline, mini goals)</span></label>
     <label class="row mt"><input type="checkbox" id="gShareAns" style="width:auto" ${val(me(), 'settings', 'main', 'shareAnswers') ? 'checked' : ''} ${sharesGoal(me()) ? '' : 'disabled'}><span>Also share my answers to questions 2-9</span></label>
     <div class="sub mt">Off = only you can see them${partner() ? ' (and your buddy ' + esc(pname(partner())) + ')' : ''}. You can change this any time.</div></div>` : ''}
   ${mine ? `<div class="card sub">Set <b>SMART</b> goals: Specific, Meaningful, Achievable, Rewarding, Time based (booklet pp. 6-13). Pick a time when you're in a great mood, put some music on, and answer honestly and in detail. Saved as you go.</div>` : ''}
   <div class="card"><label class="f"><b>Goal deadline</b> - the date you'll achieve it by</label><input type="date" ${ro} data-f="${k('deadline')}" value="${esc(g('deadline') || '')}">
   ${g('deadline') ? `<div class="sub mt">${Math.round((parseISO(g('deadline')) - parseISO(todayISO())) / 864e5)} days to go</div>` : ''}</div>`;
  if (!canQ1) { view().innerHTML = html.replace(/<div class="card"><label class="f"><b>Goal deadline[\s\S]*$/, ''); return wireGoalShare(); }
  for (const [q, text, hint] of GOAL_QS) {
    if (q !== 'q1' && !canAns) continue;
    html += `<div class="card"><label class="f goalq">${q.slice(1)}. ${esc(text)}</label>${hint && mine ? `<div class="sub">${esc(hint)}</div>` : ''}` +
      (q === 'q9' ? selectHtml(k(q), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], g(q), '–') .replace('<select', `<select ${ro}`)
        : `<textarea ${ro} rows="3" data-f="${k(q)}" placeholder="${mine ? 'Your answer' : ''}">${esc(g(q) || '')}</textarea>`) + `</div>`;
  }
  html += `<h2>Mini goals</h2><div class="sub">Break your big goal into steps and tick them off as you go.</div><div class="card">`;
  for (let j = 1; j <= N_MINI; j++) {
    const mk = f => `${who}|goals|m${j}|${f}`; const mv = f => val(who, 'goals', 'm' + j, f);
    html += `<div class="mini"><div class="n">${j}</div><input ${ro} data-f="${mk('text')}" placeholder="${mine ? 'Mini goal' : ''}" value="${esc(mv('text') || '')}">
      <input ${ro} type="date" data-f="${mk('by')}" value="${esc(mv('by') || '')}">
      <button class="done ${mv('done') ? 'on' : ''}" ${ro} data-goaldone="${j}">✓</button></div>`;
  }
  view().innerHTML = html + `</div>`; wireGoalShare();
}
function wireGoalShare() {
  if ($('#gShare')) $('#gShare').onchange = e => { setVal(me(), 'settings', 'main', 'shareGoals', e.target.checked || null); render(); };
  if ($('#gShareAns')) $('#gShareAns').onchange = e => setVal(me(), 'settings', 'main', 'shareAnswers', e.target.checked || null);
}

/* ----- progress ----- */
function weekStats(who, w) {
  const ss = P.sessions.filter(s => s.week === w);
  const bw = ss.filter(isStr), hi = ss.filter(s => s.type === 'HIIT');
  const planned = bw.reduce((a, s) => a + setsFor(s, where(who, s)).length, 0), done = bw.reduce((a, s) => a + setsDone(who, s), 0);
  let st = 0; for (let i = 0; i < 7; i++) { const d = iso(addDays(parseISO(weekStart(w, who)), i)); if ((val(who, 'stretch', d, 's') || []).filter(Boolean).length === 9) st++; }
  const rideN = rides(who).filter(([, r]) => { const dd = Math.floor((parseISO(r.date) - parseISO(weekStart(w, who))) / 864e5); return dd >= 0 && dd < 7; }).length;
  return { bw: bw.filter(s => status(who, s.id) === 'Done').length, hi: hi.filter(s => status(who, s.id) === 'Done').length, pct: planned ? Math.round(done / planned * 100) : 0, st, rides: rideN };
}
function vProgress() {
  const ws = [...Array(12)].map((_, i) => i + 1); const pt = partner();
  const cell = (v, full, cls) => `<td class="${cls} ${v >= full ? 'full' : ''}">${v}</td>`;
  view().innerHTML = `<h1>Progress</h1><div class="sub">Strength /3 · HIIT /2 · sets % · stretch days /7 · rides. <span style="color:var(--acc2)">${pname(me())}</span>${pt ? ` vs <span style="color:var(--jarom)">${pname(pt)}</span>` : ''}</div>
  <div class="card"><table class="prog"><tr><th>Wk</th><th>Str</th><th>HIIT</th><th>Sets</th><th>🧘</th><th>Ride</th>${pt ? '<th>Str</th><th>HIIT</th><th>Sets</th><th>🧘</th><th>Ride</th>' : ''}</tr>
  ${ws.map(w => { const a = weekStats(me(), w), b = pt && weekStats(pt, w);
    return `<tr><td><a href="#week/${w}">${w}</a></td>${cell(a.bw, 3, 'me')}${cell(a.hi, 2, 'me')}${cell(a.pct, 100, 'me')}${cell(a.st, 7, 'me')}${cell(a.rides, 99, 'me')}
    ${b ? cell(b.bw, 3, 'pt') + cell(b.hi, 2, 'pt') + cell(b.pct, 100, 'pt') + cell(b.st, 7, 'pt') + cell(b.rides, 99, 'pt') : ''}</tr>`; }).join('')}</table></div>`;
}

/* ----- team: my team card, coach view, athlete view, admin ----- */
const ROLE_LABEL = { head: 'Head coach', lead: 'Ride lead', athlete: 'Athlete' };
function myTeamCard() {
  const opts = people().filter(p => p !== me()).sort((a, b) => pname(a).localeCompare(pname(b)));
  const b = buddyPick(me()); const mutual = partner();
  return `<div class="card"><h3>My team</h3>
   <div class="sub">${esc(ROLE_LABEL[roleOf()] || 'Athlete')}${groupOf(me()) ? ' · ' + esc(groupName(groupOf(me()))) : ''}${isAdmin() ? ' · Admin' : ''}${T_().settings?.main?.teamName ? ' · ' + esc(T_().settings.main.teamName) : ''}</div>
   <label class="f">Training buddy (optional - you both have to pick each other)</label>
   <select id="sBuddy"><option value="">No buddy</option>${opts.map(p => `<option value="${p}" ${b === p ? 'selected' : ''}>${esc(pname(p))}</option>`).join('')}</select>
   ${b ? `<div class="sub mt">${mutual ? '✓ Buddies - you can see each other\'s sessions and goals.' : 'Waiting for ' + esc(pname(b)) + ' to pick you too.'}</div>` : ''}
   ${isCoach() ? `<label class="row mt"><input type="checkbox" id="sShareTr" style="width:auto" ${val(me(), 'settings', 'main', 'shareTraining') ? 'checked' : ''}><span>Let the other coaches see my own training</span></label>` : ''}</div>`;
}
function adminCard() {
  const gs = groups(true); const ps = Object.keys(T_().people || {}).filter(x => !tp(x, 'removed')).sort((a, b) => pname(a).localeCompare(pname(b)));
  const connected = Object.values(sv().athletes || {}).filter(a => a && !a.needsReconnect).length;
  const gsel = (pid) => `<select data-adm="${pid}|group"><option value="">No group</option>${groups().map(g => `<option value="${g}" ${groupOf(pid) === g ? 'selected' : ''}>${esc(groupName(g))}</option>`).join('')}</select>`;
  return `<div class="card admin"><h3>Admin</h3>
   <label class="f">Team name</label><input data-f="team|settings|main|teamName" value="${esc(T_().settings?.main?.teamName || '')}">
   <label class="f">Season (parents of under-18s confirm permission once per season)</label><input data-f="team|settings|main|season" placeholder="${esc(T_()._season || 'e.g. 2026-27')}" value="${esc(T_().settings?.main?.season || '')}">
   <div class="sub">Format 2026-27. Leave blank and it changes automatically on Aug 1.</div>
   ${T_().settings?.main?.season && !SEASON_RE.test(T_().settings.main.season) ? '<div class="warnbox">This season value doesn\'t look right. Clear it or type one like 2026-27.</div>' : ''}
   ${relayMode() ? '' : '<div class="warnbox">To make invite codes, sign this phone in with your own invite code first. <button class="btn small mt" id="admSwitch">Enter my invite code</button></div>'}
   <div class="sub mt">Strava places used in this app: <b>${connected}</b> (the Strava API limit of 10 is shared with the two-person app).</div>
   <h3 class="mt">Ride groups</h3>
   ${gs.map(g => `<div class="row mt"><input class="grow" data-f="team|groups|${g}|name" value="${esc(groupName(g))}" ${T_().groups[g].retired ? 'disabled' : ''}>
     <button class="btn small sec" data-gretire="${g}">${T_().groups[g].retired ? 'Bring back' : 'Retire'}</button></div>`).join('') || '<div class="sub">No groups yet.</div>'}
   <div class="row mt"><input id="aGroup" placeholder="New group name"><button class="btn small" id="aGroupAdd">Add</button></div>
   <h3 class="mt">People</h3>
   ${ps.map(pid => `<div class="person ${tp(pid, 'active') === false ? 'off' : ''}"><div class="row"><b class="grow">${esc(pname(pid))}</b><span class="sub">${pid}</span></div>
     <div class="grid2 mt"><select data-adm="${pid}|role">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${roleOf(pid) === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${gsel(pid)}</div>
     <div class="row mt sub"><label><input type="checkbox" data-admchk="${pid}|minor" ${tp(pid, 'minor') ? 'checked' : ''}> Under 18</label>
     <label><input type="checkbox" data-admchk="${pid}|admin" ${tp(pid, 'admin') ? 'checked' : ''} ${pid === me() ? 'disabled' : ''}> Admin</label>
     <label><input type="checkbox" data-admchk="${pid}|active" ${tp(pid, 'active') !== false ? 'checked' : ''} ${pid === me() ? 'disabled' : ''}> Active</label></div>
     ${relayMode() ? `<div class="sub mt" id="ast-${pid}">${admStatusLine(pid)}</div>
     <div class="row mt adm-acts">${tp(pid, 'active') !== false ? `<button class="btn small" data-ainvite="${pid}">Invite code</button>` : ''}
       <button class="btn small sec" data-asignout="${pid}">Sign out phones</button>${pid !== me() ? `<button class="btn small danger" data-adelete="${pid}">Remove + delete data</button>` : ''}</div>
     <div id="acode-${pid}"></div>` : ''}</div>`).join('')}
   <h3 class="mt">Add a person</h3>
   <input id="aName" placeholder="First name (shown in the app)">
   <div class="grid2 mt"><select id="aRole">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${k === 'athlete' ? 'selected' : ''}>${l}</option>`).join('')}</select>
   <select id="aGrp"><option value="">No group</option>${groups().map(g => `<option value="${g}">${esc(groupName(g))}</option>`).join('')}</select></div>
   <label class="row mt"><input type="checkbox" id="aMinor" style="width:auto"><span>Under 18 (parent permission will be needed before invite codes go live)</span></label>
   <button class="btn block" id="aAdd">Add person</button>
   <div class="sub mt">Pilot phase 1: new people join with a GitHub token for mtb-team-data. Invite codes come in phase 2.</div></div>`;
}
let ADM = null;   // /admin/status: phones, open invite codes, parent permission per person
function admStatusLine(pid) {
  const a = ADM?.people?.[pid]; if (!a) return ADM ? '' : 'Loading…';
  const bits = [a.phones ? `📱 ${a.phones} phone${a.phones > 1 ? 's' : ''} signed in` : 'Not signed in yet'];
  if (a.code) bits.push(`code ${a.code.code} (until ${new Date(a.code.exp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})`);
  if (tp(pid, 'minor')) bits.push(a.consent ? `✓ parent permission ${ADM.season}` : `⏳ waiting for parent permission (${ADM.season})`);
  return bits.join(' · ');
}
async function loadAdm() { if (!relayMode() || !isAdmin()) return; try { ADM = await relay('GET', '/admin/status'); for (const pid of Object.keys(ADM.people)) { const el = $('#ast-' + pid); if (el) el.textContent = admStatusLine(pid); } } catch (e) { toast(e.message); } }
function showCode(pid, r) {
  const el = $('#acode-' + pid); if (!el) return;
  el.innerHTML = `<div class="codebox"><div class="bigcode">${esc(r.code)}</div><div class="sub">Single use · expires ${new Date(r.exp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
    <input readonly value="${esc(r.link)}"><button class="btn block small" data-ashare="${pid}">Send to ${esc(pname(pid))}</button></div>`;
  el.querySelector('[data-ashare]').onclick = async () => {
    const text = `Hi ${pname(pid)}! Here's your invite to MTB 12 Team. Open this link on your phone (code ${r.code}):`;
    if (navigator.share) { try { await navigator.share({ title: 'MTB 12 Team invite', text, url: r.link }); return; } catch { } }
    try { await navigator.clipboard.writeText(`${text} ${r.link}`); toast('Copied - paste it into a text or email'); } catch { toast('Copy the link above'); }
  };
}
const slug = n => n.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'person';
function wireTeamSettings() {
  if ($('#sBuddy')) $('#sBuddy').onchange = e => { setVal(me(), 'settings', 'main', 'buddy', e.target.value || null); render(); };
  if ($('#sShareTr')) $('#sShareTr').onchange = e => setVal(me(), 'settings', 'main', 'shareTraining', e.target.checked || null);
  if (!isAdmin()) return;
  if (relayMode()) { loadAdm();
    document.querySelectorAll('[data-ainvite]').forEach(b => b.onclick = async () => { const pid = b.dataset.ainvite;
      if (ADM?.people?.[pid]?.code && !confirm('This replaces the code that was already sent. Continue?')) return;
      try { const r = await relay('POST', '/admin/invite', { pid }); showCode(pid, r); loadAdm(); } catch (e) { toast(e.message); } });
    document.querySelectorAll('[data-asignout]').forEach(b => b.onclick = async () => { const pid = b.dataset.asignout;
      if (!confirm(`Sign out all of ${pname(pid)}'s phones? Their training stays saved; they'll need a new invite code.`)) return;
      try { const r = await relay('POST', '/admin/revoke', { pid }); toast(`${r.phones} phone(s) signed out`); if (pid === me()) location.reload(); else loadAdm(); } catch (e) { toast(e.message); } });
    document.querySelectorAll('[data-adelete]').forEach(b => b.onclick = async () => { const pid = b.dataset.adelete;
      if (prompt(`This permanently deletes ${pname(pid)}'s training data and permission records, and signs out their phones.\n\nType their name to confirm:`)?.trim().toLowerCase() !== pname(pid).toLowerCase()) return toast('Not deleted');
      try { await relay('POST', '/admin/delete', { pid });
        setVal('team', 'people', pid, 'active', false); setVal('team', 'people', pid, 'removed', true); setVal('team', 'people', pid, 'name', null); delete D[pid];
        toast('Removed and deleted'); render(); } catch (e) { toast(e.message); } });
  }
  document.querySelectorAll('[data-adm]').forEach(el => el.onchange = () => { const [pid, f] = el.dataset.adm.split('|'); setVal('team', 'people', pid, f, el.value || null); render(); });
  document.querySelectorAll('[data-admchk]').forEach(el => el.onchange = () => { const [pid, f] = el.dataset.admchk.split('|'); setVal('team', 'people', pid, f, f === 'active' ? el.checked : (el.checked || null)); render(); });
  if ($('#aGroupAdd')) $('#aGroupAdd').onclick = () => { const n = $('#aGroup').value.trim(); if (!n) return; const g = 'g' + Date.now().toString(36); setVal('team', 'groups', g, 'name', n); render(); };
  if ($('#aAdd')) $('#aAdd').onclick = () => {
    const n = $('#aName').value.trim(); if (!n) return toast('Enter a name');
    let pid = slug(n), i = 2; while (T_().people?.[pid]) pid = slug(n) + i++;
    setVal('team', 'people', pid, 'name', n); setVal('team', 'people', pid, 'role', $('#aRole').value); setVal('team', 'people', pid, 'group', $('#aGrp').value || null);
    setVal('team', 'people', pid, 'minor', $('#aMinor').checked || null); setVal('team', 'people', pid, 'active', true); setVal('team', 'people', pid, 'joined', todayISO());
    toast(`${n} added (${pid})`); render();
  };
}
/* coach view: one row per athlete the coach can see */
function lastWorkout(pid) { let l = ''; for (const r of Object.values(D[pid]?.sessions || {})) if (['Done', 'Partial'].includes(r.status) && r.dateDone > l) l = r.dateDone; return l; }
function athleteRow(pid) {
  const { w, brk } = weekInfo(pid); const wk = Math.min(12, Math.max(1, w));
  const ss = P.sessions.filter(s => s.week === wk); const done = ss.filter(s => ['Done', 'Partial'].includes(status(pid, s.id))).length;
  let pl = 0, dn = 0; for (const s of P.sessions.filter(isStr)) if (['Done', 'Partial'].includes(status(pid, s.id))) { pl += setsFor(s, where(pid, s)).length; dn += setsDone(pid, s); }
  const last = lastWorkout(pid); const quiet = w >= 1 && w <= 12 && (!last || (parseISO(todayISO()) - parseISO(last)) / 864e5 > 7);
  const behind = w >= 1 && w <= 12 && !brk && done < Math.min(5, Math.floor(((new Date().getDay() + 6) % 7) * 5 / 7));
  return { pid, w, brk, done, n: ss.length, pct: pl ? Math.round(dn / pl * 100) : null, last, quiet, behind,
    deadline: sharesGoal(pid) ? val(pid, 'goals', 'main', 'deadline') : null, strava: !!(sv().athletes?.[pid] && !sv().athletes[pid].needsReconnect) };
}
function vTeam(filter) {
  if (!isCoach()) return vToday();
  const list = coachSees(); const head = roleOf() === 'head';
  const shown = list.filter(p => !filter || filter === 'all' || groupOf(p) === filter || (filter === 'coaches' && isCoach(p)));
  const rows = shown.map(athleteRow).sort((a, b) => (b.quiet + b.behind) - (a.quiet + a.behind) || pname(a.pid).localeCompare(pname(b.pid)));
  view().innerHTML = `<h1>Team</h1><div class="sub">${head ? 'Head coach - all athletes' : 'Ride lead - ' + esc(groupName(groupOf(me())) || 'your group')} · read-only · only what's logged in the app</div>
   ${head ? `<div class="seg mt tseg"><button data-tfilter="all" class="${!filter || filter === 'all' ? 'on' : ''}">All</button>${groups().map(g => `<button data-tfilter="${g}" class="${filter === g ? 'on' : ''}">${esc(groupName(g))}</button>`).join('')}</div>` : ''}
   ${rows.length ? rows.map(r => `<a class="card sess team ${r.quiet || r.behind ? 'flag' : ''}" href="#athlete/${r.pid}">
     <div class="day ${isCoach(r.pid) ? 'coach' : ''}">${esc(pname(r.pid).slice(0, 2))}<small>${r.w === 0 ? 'soon' : r.w > 12 ? 'done' : 'wk ' + r.w}</small></div>
     <div class="grow"><h3>${esc(pname(r.pid))}${isCoach(r.pid) ? ' <span class="sub">(coach)</span>' : ''}</h3>
     <div class="sub">${r.w === 0 ? 'Starts ' + fmt(startISO(r.pid)) : r.w > 12 ? 'Program complete' : (r.brk ? 'Break week · ' : '') + `This week ${r.done}/${r.n}`}${r.pct != null ? ` · sets ${r.pct}%` : ''} · last ${r.last ? fmt(r.last, { month: 'short', day: 'numeric' }) : '–'}</div>
     <div>${(T_()._pending || []).includes(r.pid) ? '<span class="chip Partial">awaiting parent permission</span>' : ''}${r.quiet ? '<span class="chip Skipped">quiet 7+ days</span>' : ''}${r.behind ? '<span class="chip Partial">behind this week</span>' : ''}${r.deadline ? `<span class="chip">🎯 ${fmt(r.deadline, { month: 'short', day: 'numeric' })}</span>` : ''}${r.strava ? '<span class="chip">Strava ✓</span>' : ''}${head && groupOf(r.pid) ? `<span class="chip">${esc(groupName(groupOf(r.pid)))}</span>` : ''}</div></div></a>`).join('')
     : `<div class="card sub">No athletes to show yet${head ? '' : ' in your group'}. The admin assigns athletes to groups in Settings - Admin.</div>`}`;
}
function vAthlete(arg) {
  const [pid, wa] = (arg || '').split(':');
  if (!coachSees().includes(pid)) return vTeam();
  const r = athleteRow(pid); const wk = Math.min(12, Math.max(1, +wa || r.w || 1));
  const ss = P.sessions.filter(s => s.week === wk);
  const line = s => { const st = status(pid, s.id) || '—'; const t = isStr(s) ? where(pid, s) : null;
    return `<div class="card sess"><div class="day d-${s.suggested_day}">${s.suggested_day}<small>${fmt(sessDate(s, pid), { month: 'numeric', day: 'numeric' })}</small></div>
     <div class="grow"><h3>${s.type === 'HIIT' ? 'HIIT ' + s.n : tIcon(t) + ' Strength ' + s.n}</h3>
     <div class="sub">${t ? `${setsDone(pid, s, t)}/${setsFor(s, t).length} sets` : (val(pid, 'hiit', s.id, 'intervals') != null ? val(pid, 'hiit', s.id, 'intervals') + '/' + interval(s.week).reps + ' intervals' : '')}${myDate(pid, s.id) ? ' · ' + fmt(myDate(pid, s.id)) : ''}${val(pid, 'sessions', s.id, 'rpe') ? ' · RPE ' + val(pid, 'sessions', s.id, 'rpe') : ''}</div>
     <span class="chip ${esc(st)}">${esc(st)}</span></div></div>`; };
  let st = 0; for (let i = 0; i < 7; i++) if ((val(pid, 'stretch', iso(addDays(new Date(), -i)), 's') || []).filter(Boolean).length === 9) st++;
  view().innerHTML = `<a href="#team" class="sub">‹ Team</a><h1>${esc(pname(pid))}</h1>
   <div class="sub">${esc(ROLE_LABEL[roleOf(pid)])}${groupOf(pid) ? ' · ' + esc(groupName(groupOf(pid))) : ''} · started ${fmt(startISO(pid))} · stretches ${st}/7 days this past week</div>
   <div class="row mt"><a class="btn sec small" href="#athlete/${pid}:${wk - 1}" ${wk <= 1 ? 'style="visibility:hidden"' : ''}>‹</a><div class="grow center"><b>Week ${wk}</b> <span class="sub">${fmt(weekStart(wk, pid))}</span></div><a class="btn sec small" href="#athlete/${pid}:${wk + 1}" ${wk >= 12 ? 'style="visibility:hidden"' : ''}>›</a></div>
   ${ss.map(line).join('')}
   ${sharesGoal(pid) ? `<a class="btn block sec" href="#goals/${pid}">🎯 View ${esc(pname(pid))}'s goals</a>` : '<div class="sub center mt">Goals not shared.</div>'}`;
}

/* ----- settings ----- */
function scheduleCard() {
  const L = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
  const { w } = weekInfo();
  const doneIn = wk => P.sessions.some(x => x.week === wk && ['Done', 'Partial'].includes(status(me(), x.id)));
  const def = Math.min(12, Math.max(2, w >= 1 && w <= 12 ? (doneIn(w) ? w + 1 : w) : 2));
  const pushes = []; for (let k = 2; k <= 12; k++) if (pushAt(me(), k)) pushes.push(k);
  return `<div class="card" id="schedCard"><h3>My schedule</h3>
   <label class="f">My start date (Monday of week 1)</label><input type="date" id="sStart" value="${startISO()}">
   <div class="sub">Week 1 starts ${fmt(startISO(), L)} · finishes ${fmt(progEnd(), L)}. Any date you pick moves to that week's Monday. Only your own dates change.</div>
   ${pushes.map(k => `<div class="row mt"><div class="grow">⏸ ${pushAt(me(), k)} week${pushAt(me(), k) > 1 ? 's' : ''} pushed back before week ${k} <span class="sub">(week ${k} now starts ${fmt(weekStart(k))})</span></div><button class="btn small sec" data-unpush="${k}">Undo</button></div>`).join('')}
   <label class="f mt">Missed a week? Push back 1 week, starting from</label>
   <div class="grid2"><select id="sPushW">${[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(k => `<option value="${k}" ${k === def ? 'selected' : ''}>Week ${k} (${fmt(weekStart(k), { month: 'short', day: 'numeric' })})</option>`).join('')}</select>
   <button class="btn small sec" id="sPush">Push back 1 week</button></div>
   <div class="sub">That week and everything after it move one week later, keeping the Mon–Sun layout. Sessions you've already done keep their dates. To move week 1, change your start date.</div></div>`;
}
function vSettings(a) {
  view().innerHTML = `<h1>Settings</h1><div class="card">
   ${relayMode() ? `<div>Signed in as <b>${esc(pname(me()))}</b> with an invite code.</div>
     <label class="f">My default track for strength sessions</label><select id="sTrack">${['Home', 'Gym'].map(x => `<option ${defTrack(me()) === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
     ${restSettingHtml()}
     <button class="btn block" id="sSaveR">Save</button><button class="btn block sec small" id="sSignOut">Sign out of this phone</button></div>` : `
   ${configured() ? `<div class="codebox" id="switchBox"><b>Switch this phone to an invite code</b><div class="sub">Type the code here (not in any other field). Your training stays as it is.</div><input id="sCodeSw" placeholder="ABCD-EFGH" autocapitalize="characters" autocomplete="off"><button class="btn block small mt" id="sCodeSwGo">Use invite code</button></div>` : ''}
   ${!configured() ? `<div class="card sub">Got an invite code? <a href="#" id="sUseCode">Use it here</a>.</div>` : ''}
   ${people().length ? `<label class="f">Who is using this phone?</label><select id="sMe"><option value="">Choose…</option>${people().sort((a, b) => pname(a).localeCompare(pname(b))).map(p => `<option value="${p}" ${cfg.me === p ? 'selected' : ''}>${esc(pname(p))}</option>`).join('')}</select>`
     : `<input type="hidden" id="sMe" value=""><div class="sub">Fill in the GitHub details below and tap <b>Save &amp; sync</b> - then pick your name.</div>`}
   <label class="f">My default track for strength sessions</label><select id="sTrack">${['Home', 'Gym'].map(x => `<option ${(cfg.me ? defTrack(cfg.me) : 'Home') === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
   <div class="sub">You can still switch Home/Gym on any session.</div>
   <label class="f">GitHub username (repo owner)</label><input id="sOwner" autocapitalize="off" autocorrect="off" value="${esc(cfg.owner)}">
   <label class="f">Private data repo name</label><input id="sRepo" autocapitalize="off" autocorrect="off" value="${esc(cfg.repo)}">
   <label class="f">GitHub token (fine-grained, Contents: read & write on that repo only)</label><input id="sTok" type="password" autocomplete="off" value="${esc(cfg.token)}">
   ${restSettingHtml()}
   <details class="mt"><summary class="sub">Advanced</summary><label class="f">API base URL</label><input id="sApi" autocapitalize="off" value="${esc(cfg.api)}"></details>
   <button class="btn block" id="sSave">Save & sync</button>
</div>`}
   ${configured() && P ? myTeamCard() : ''}
   ${configured() && P ? stravaSettings() : ''}
   ${configured() && P ? scheduleCard() : ''}
   ${configured() && P && isAdmin() ? adminCard() : ''}
   <div class="card"><h3>Program</h3>
   <p class="sub">Intro video: 10 common questions from people following the program.</p>
   <a class="btn block sec" href="${INTRO_VIDEO}" target="_blank" rel="noopener">▶ Watch the intro video</a></div>
   <div class="card"><h3>Data</h3>
   <div class="sub">Last sync: ${syncState.last ? new Date(syncState.last).toLocaleString() : 'never'}${syncState.err ? `<br><span style="color:var(--bad)">${esc(syncState.err)}</span>` : ''}</div>
   <button class="btn block sec" id="sProg">Reload program from repo</button>
   <button class="btn block sec" id="sExport">Download backup (JSON)</button>
   <button class="btn block danger" id="sReset">Clear data on this phone</button>
   <p class="sub mt">MTB 12 Team (pilot) · app v${APP_VERSION}</p></div>`;
  if ($('#sUseCode')) $('#sUseCode').onclick = e => { e.preventDefault(); vSetup(); };
  if ($('#admSwitch')) $('#admSwitch').onclick = () => { const b = $('#switchBox'); if (b) { b.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => $('#sCodeSw').focus(), 400); } };
  if ($('#sCodeSwGo')) $('#sCodeSwGo').onclick = () => { const c = $('#sCodeSw').value.trim(); if (!c) return; cfg = { ...cfg, me: '', token: '' }; LS.set('cfg', cfg); vJoin(c); };
  if ($('#sSaveR')) $('#sSaveR').onclick = () => { cfg = { ...cfg, restOverride: readRestSetting() }; LS.set('cfg', cfg); render(); if (defTrack(me()) !== $('#sTrack').value) setVal(me(), 'settings', 'main', 'defaultTrack', $('#sTrack').value); toast('Saved'); };
  if ($('#sSignOut')) $('#sSignOut').onclick = () => { if (confirm('Sign out of this phone? Your training stays saved; you will need a new invite code from your coach to sign back in.')) { Object.keys(localStorage).filter(k => k.startsWith('mtbteam.')).forEach(k => localStorage.removeItem(k)); location.href = location.pathname; } };
  if ($('#sSave')) $('#sSave').onclick = async () => {
    cfg = { ...cfg, me: $('#sMe').value || '', owner: $('#sOwner').value.trim(), repo: $('#sRepo').value.trim(), token: $('#sTok').value.trim(), api: ($('#sApi').value.trim() || 'https://api.github.com'), restOverride: readRestSetting() };
    LS.set('cfg', cfg);
    if (!(cfg.owner && cfg.repo && cfg.token)) return toast('Fill in all fields');
    if (!cfg.me) { try { await loadTeam(); toast('Now choose your name'); render(); } catch (e) { toast(e.message); } return; }
    if (defTrack(cfg.me) !== $('#sTrack').value || !val(cfg.me, 'settings', 'main', 'defaultTrack')) setVal(cfg.me, 'settings', 'main', 'defaultTrack', $('#sTrack').value);
    try { await loadProgram(); prep(); await syncNow(true); location.hash = '#today'; render(); } catch (e) { toast(e.message); syncState.err = e.message; paintSync(); }
  };
  if ($('#sStart')) $('#sStart').onchange = e => { if (e.target.value) { setVal(me(), 'settings', 'main', 'startDate', monday(e.target.value)); toast('Start date: ' + fmt(monday(e.target.value))); render(); } };
  if ($('#sPush')) $('#sPush').onclick = () => { const k = +$('#sPushW').value; setVal(me(), 'settings', 'main', 'push' + k, pushAt(me(), k) + 1); toast(`Week ${k} onward pushed back a week`); render(); };
  if (a === 'schedule') setTimeout(() => $('#schedCard')?.scrollIntoView({ block: 'start' }), 50);
  wireTeamSettings();
  if ($('#sGarmin')) $('#sGarmin').onchange = e => setVal(me(), 'settings', 'main', 'garmin', e.target.checked);
  if ($('#sStravaOff')) $('#sStravaOff').onclick = () => { if (confirm('Disconnect Strava?\n\nThe app will stop adding your workouts to Strava and stop bringing in your rides. Anything already on Strava stays there.\n\nTo remove the app from your Strava account completely, open Strava → Settings → My Apps.')) { setVal(me(), 'settings', 'main', 'stravaDisconnect', Date.now()); stravaKick('disconnect'); render(); } };
  if ($('#sCodeGo')) $('#sCodeGo').onclick = () => {
    let t = $('#sCode').value.trim(); if (!t) return;
    if (t.includes('code=')) { const u = new URLSearchParams(t.slice(t.indexOf('?') + 1)); t = u.get('code') + '|' + (u.get('scope') || ''); }
    const [c, sc] = t.split('|'); if (stravaAcceptCode(c, sc)) render();
  };
  $('#sProg').onclick = async () => { try { await loadProgram(); prep(); toast('Program reloaded'); render(); } catch (e) { toast(e.message); } };
  $('#sExport').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ exported: new Date().toISOString(), data: D }, null, 1)], { type: 'application/json' })); a.download = `mtb-backup-${todayISO()}.json`; a.click(); };
  $('#sReset').onclick = () => { if (confirm('Remove all data stored on this phone? (Data already synced to GitHub stays there.)')) { localStorage.removeItem('mtbteam.data'); localStorage.removeItem('mtbteam.shas'); D = {}; shas = {}; toast('Cleared - syncing'); syncNow(); } };
}

/* ---------------- events ---------------- */
document.addEventListener('change', e => {
  const el = e.target; const f = el.dataset?.f; if (!f) return;
  const [file_, coll, key, field] = f.split('|');
  let v = el.value.trim();
  if (el.hasAttribute('data-num') && v !== '') { const n = Number(v.replace(',', '.')); v = isNaN(n) ? v : n; }
  if ((field === 'rpe' || field === 'q9') && v !== '') v = Number(v);
  if (file_ === 'team' && field === 'season' && v !== '' && !SEASON_RE.test(v)) { toast('Season should look like 2026-27 (leave blank for automatic).'); el.value = T_().settings?.main?.season && SEASON_RE.test(T_().settings.main.season) ? T_().settings.main.season : ''; return; }
  if (coll === 'rides') saveRideDraft(key);   // first entry on a new ride saves its date + rider too
  setVal(file_, coll, key, field, v === '' ? null : v);
  if ((coll === 'sets' || coll === 'gsets') && v !== '' && v !== null && field !== 'band') autoDate(key.split('-').slice(0, 2).join('-'));
  if (field === 'status' && v === 'Done') autoDate(key);
});
document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.done) {
    const [coll, lid] = t.dataset.done.split('|'); const on = !val(me(), coll, lid, 'done');
    setVal(me(), coll, lid, 'done', on ? true : null); t.classList.toggle('on', on);
    if (on) { autoDate(lid.split('-').slice(0, 2).join('-')); restForSet(lid); vib(40); roundAdvance(lid); }
  } else if (t.dataset.gview) { setVal(me(), 'settings', 'main', 'gymView', t.dataset.gview); render();
  } else if (t.dataset.ropen) { const j = t.dataset.ropen.lastIndexOf('|'), key = t.dataset.ropen.slice(0, j); (RX[key] = RX[key] || new Set()).add(+t.dataset.ropen.slice(j + 1)); render();
  } else if (t.dataset.sprint) { sprintRun(t);
  } else if (t.dataset.where) {
    const [sid, tr] = t.dataset.where.split('|'); setVal(me(), 'sessions', sid, 'where', tr); render();
  } else if (t.dataset.tstart) { startT(t.dataset.tstart);
  } else if (t.dataset.tskip) { skipT(t.dataset.tskip);
  } else if (t.dataset.warm !== undefined) {
    setVal(me(), 'settings', 'main', 'warmupMin', +t.dataset.warm); t.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === t));
  } else if (t.dataset.tpause) { pauseT(t.dataset.tpause);
  } else if (t.dataset.tstop) { if (T && T.box === t.dataset.tstop) endT(true);
  } else if (t.dataset.introdone) {
    setVal(me(), 'settings', 'main', 'introWatched', true); render();
  } else if (t.dataset.finish) {
    const id = t.dataset.finish; setVal(me(), 'sessions', id, 'status', 'Done'); autoDate(id); toast('Nice work! 💪');
    if (stravaAthlete()) stravaKick('finish');
    location.hash = '#today';
  } else if (t.dataset.tfilter) { vTeam(t.dataset.tfilter);
  } else if (t.dataset.gretire) { const g = t.dataset.gretire; setVal('team', 'groups', g, 'retired', T_().groups[g].retired ? null : true); render();
  } else if (t.dataset.goaldone) {
    const j = t.dataset.goaldone; const on = !val(me(), 'goals', 'm' + j, 'done'); setVal(me(), 'goals', 'm' + j, 'done', on ? true : null); t.classList.toggle('on', on); if (on) vib(40);
  } else if (t.dataset.goalswho !== undefined) {
    location.hash = '#goals' + (t.dataset.goalswho ? '/' + t.dataset.goalswho : '');
  } else if (t.dataset.unpush) {
    const k = +t.dataset.unpush; setVal(me(), 'settings', 'main', 'push' + k, pushAt(me(), k) - 1 || null); render();
  } else if (t.dataset.spost) {
    stravaReq(t.dataset.spost, 'post'); toast('Sending to Strava…'); softRender();
  } else if (t.dataset.sskip) {
    stravaReq(t.dataset.sskip, 'skip'); softRender();
  } else if (t.dataset.stretch) {
    const [d, i] = t.dataset.stretch.split('|'); const arr = [...(val(me(), 'stretch', d, 's') || Array(9).fill(false))];
    arr[+i] = !arr[+i]; setVal(me(), 'stretch', d, 's', arr); t.classList.toggle('on', arr[+i]);
  } else if (t.dataset.stretchall) {
    setVal(me(), 'stretch', t.dataset.stretchall, 's', Array(9).fill(true)); render();
  } else if (t.dataset.delride) {
    const id = t.dataset.delride;
    if (!rec(me(), 'rides', id)) { rideDraft = null; location.hash = '#rides'; }   // never saved - nothing to delete
    else if (confirm('Delete this ride?')) { setVal(me(), 'rides', id, 'deleted', true); location.hash = '#rides'; }
  } else if (t.dataset.rest) {
    if (t.dataset.rest === 'skip') stopRest(); else if (rest) rest.end += 15000;
  } else if (t.dataset.hold !== undefined) {
    holdTimer(t, +t.dataset.hold);
  }
});
function autoDate(sid) {   // first thing you log in a session stamps YOUR date (not your partner's)
  if (!P._sess[sid] || val(me(), 'sessions', sid, 'dateDone')) return;
  const d = todayISO();
  setVal(me(), 'sessions', sid, 'dateDone', d);
  const i = document.querySelector(`[data-f="${me()}|sessions|${sid}|dateDone"]`); if (i) i.value = d;
}
// long answers (goals, notes): save while typing, and when the app is put away, not only when the box loses focus
let typeT = null;
document.addEventListener('input', e => { const el = e.target; if (el.tagName !== 'TEXTAREA' || !el.dataset.f) return; clearTimeout(typeT); typeT = setTimeout(() => el.dispatchEvent(new Event('change', { bubbles: true })), 1000); });
document.addEventListener('visibilitychange', () => { const el = document.activeElement; if (document.visibilityState === 'hidden' && el?.dataset?.f) el.dispatchEvent(new Event('change', { bubbles: true })); });
$('#syncBtn').onclick = () => syncNow(true);
addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); });
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 120000);
setInterval(paintSync, 30000);

/* ---------------- timers, sound, misc ---------------- */
let rest = null;
function startRest(sec, lbl = 'Rest') {
  stopRest(); rest = { end: Date.now() + sec * 1000, total: sec * 1000 }; $('#restBar').hidden = false; $('#restLbl').textContent = lbl;
  $('#restTime').textContent = clock(sec); $('#restProg').style.width = '0%';
  rest.iv = setInterval(() => {
    const left = rest.end - Date.now();
    $('#restTime').textContent = clock(Math.max(0, left / 1000)); $('#restProg').style.width = Math.min(100, 100 * (1 - left / rest.total)) + '%';
    if (left <= 0) { beep(880, .3); vib([200, 80, 200]); stopRest(); }
  }, 250);
}
function stopRest() { if (rest) clearInterval(rest.iv); rest = null; $('#restBar').hidden = true; }
function holdTimer(btn, sec) {
  if (btn._iv) { clearInterval(btn._iv); btn._iv = null; btn.textContent = `⏱ ${sec ? sec + 's timer' : 'stopwatch'}`; wake(false); return; }
  const t0 = Date.now(); wake(true); beep(880, .15);
  btn._iv = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    if (sec) { const left = sec - el; btn.textContent = `■ ${Math.ceil(Math.max(0, left))}s`; if (left <= 0) { clearInterval(btn._iv); btn._iv = null; beep(1000, .5); vib([300, 100, 300]); btn.textContent = `⏱ ${sec}s timer`; wake(false); } }
    else btn.textContent = `■ ${Math.floor(el)}s (tap to stop)`;
  }, 250);
}
let actx = null;
function beep(freq = 880, dur = .2) {
  try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = freq; o.connect(g); g.connect(actx.destination); g.gain.setValueAtTime(.25, actx.currentTime); g.gain.exponentialRampToValueAtTime(.001, actx.currentTime + dur); o.start(); o.stop(actx.currentTime + dur); } catch { }
}
const vib = p => { try { navigator.vibrate?.(p); } catch { } };
let wl = null;
async function wake(on) { try { if (on && 'wakeLock' in navigator) wl = await navigator.wakeLock.request('screen'); else if (!on && wl) { await wl.release(); wl = null; } } catch { } }
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // when a new version takes over, reload once so the new screens appear straight away
  const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => { });
}
const joinCode = new URLSearchParams(location.search).get('join');
if (joinCode && !configured()) vJoin(joinCode);
else if (!handleStravaReturn()) render();
if (configured()) syncNow();
