"use strict";

const WS_URL = "wss://api.prologuebymetama.com/ws";
const DEV_MODE = false;

const DEFAULT_CODE_LEN = 4;
const MAX_CODE_LEN = 8;
const PRESS_FEEDBACK_MS = 100;

const K_UID = "tow.uid";
const K_SESSION = "tow.session";

function $(id) { return document.getElementById(id); }
function setText(el, text) { if (el) el.textContent = text; }
function setHidden(el, hidden) { if (el) el.classList.toggle("hidden", !!hidden); }
function setAttr(el, key, val) { if (el) el.setAttribute(key, val); }

const viewInput = $("viewInput");
const viewControl = $("viewControl");
const viewEnd = $("viewEnd");
const loading = $("loading");
const toast = $("toast");
const toastText = $("toastText");

const loadingTitleEl = $("loadingTitle");
const loadingSubEl = $("loadingSub");
const roundPopup = $("roundPopup");
const roundPopupTitle = $("roundPopupTitle");
const roundPopupBody = $("roundPopupBody");
const statusDot = $("statusDot");
const uidHint = $("uidHint");

const roomCodeEl = $("roomCode");
const codeLabelEl = $("codeLabel");
const roomCodeWrapEl = $("roomCodeWrap");
const usernameEl = $("username");
const fullNameEl = $("fullName");
const btnJoin = $("btnJoin");

const btnTap = $("btnTap");
const tapImage = $("tapImage");
const teamBanner = $("teamBanner");
const teamTruck = $("teamTruck");
const teamBannerEnd = $("teamBannerEnd");
const teamTruckEnd = $("teamTruckEnd");

const devPanel = $("devPanel");
const tapCountEl = $("tapCount");
const roomView = $("roomView");
const uidView = $("uidView");

const endTitle = $("endTitle");
const endResult = $("endResult");
const endTeam = $("endTeam");
const endTaps = $("endTaps");
const endTTR = $("endTTR");
const endGTR = $("endGTR");
const btnRestart = $("btnRestart");

let ws = null;
let isConnecting = false;
let phase = "join";
let teamIndex = null;
let taps = 0;
let code = "";
let username = "";
let fullName = "";
let resumeToken = null;
let canTap = false;
let tapBuffer = 0;
let tapFlushTimer = null;
let roundPopupTimer = null;
let roundCountdownTimer = null;
let hasSeenRoundEnd = false;
let pressTimer = null;

function getOrCreateUid() {
  let uid = localStorage.getItem(K_UID);
  if (uid) return uid;
  uid = window.crypto?.randomUUID ? crypto.randomUUID() : "uid_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
  localStorage.setItem(K_UID, uid);
  return uid;
}
const clientUid = getOrCreateUid();

function loadSavedSession() {
  try {
    const raw = localStorage.getItem(K_SESSION);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveSession(patch) {
  const next = { ...(loadSavedSession() || {}), ...patch };
  localStorage.setItem(K_SESSION, JSON.stringify(next));
  return next;
}
function clearSession() { localStorage.removeItem(K_SESSION); }

function normalizeCode(v) {
  return (v || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, MAX_CODE_LEN);
}
function parseCodeFromUrl() {
  const u = new URL(window.location.href);
  return normalizeCode((u.searchParams.get("cd") || u.searchParams.get("c") || "").trim());
}
function getCodeLenFromUrlOrDefault() {
  try {
    const n = Number((new URL(window.location.href)).searchParams.get("len") || "");
    if (Number.isFinite(n) && n >= 3 && n <= MAX_CODE_LEN) return n;
  } catch {}
  return DEFAULT_CODE_LEN;
}
const CODE_LEN = getCodeLenFromUrlOrDefault();

function getTeamAssets(idx) {
  return idx === 0
    ? { name: "TEAM A", banner: "./assets/Banner_TeamA.png", truck: "./assets/TruckA.png" }
    : idx === 1
      ? { name: "TEAM B", banner: "./assets/Banner_TeamB.png", truck: "./assets/TruckB.png" }
      : { name: "TEAM —", banner: "", truck: "" };
}

function showView(which) {
  setHidden(viewInput, which !== "input");
  setHidden(viewControl, which !== "control");
  setHidden(viewEnd, which !== "end");
}
function setLoading(on, title, sub) {
  setHidden(loading, !on);
  setAttr(loading, "aria-hidden", on ? "false" : "true");
  if (title) setText(loadingTitleEl, title);
  if (sub) setText(loadingSubEl, sub);
}
let toastTimer = null;
function showToast(msg) {
  if (!toast || !toastText) return;
  setText(toastText, msg || "Something went wrong.");
  setHidden(toast, false);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setHidden(toast, true), 2400);
}
function setStatusDot(mode) {
  if (!statusDot) return;
  statusDot.classList.remove("is-red", "is-orange", "hidden");
  if (mode === "hidden" || !mode) return statusDot.classList.add("hidden");
  if (mode === "red") statusDot.classList.add("is-red");
  if (mode === "orange") statusDot.classList.add("is-orange");
}

function showRoundPopup(title, body, ms) {
  clearTimeout(roundPopupTimer);
  clearInterval(roundCountdownTimer);
  setText(roundPopupTitle, title || "ROUND");
  setText(roundPopupBody, body || "");
  setHidden(roundPopup, false);
  setAttr(roundPopup, "aria-hidden", "false");
  if (typeof ms === "number" && ms > 0) roundPopupTimer = setTimeout(hideRoundPopup, ms);
}
function hideRoundPopup() {
  clearTimeout(roundPopupTimer);
  clearInterval(roundCountdownTimer);
  setHidden(roundPopup, true);
  setAttr(roundPopup, "aria-hidden", "true");
}
function showRoundCountdown(seconds) {
  let s = Math.max(0, Number(seconds) || 0);
  showRoundPopup("NEXT ROUND", `Starting in ${s}…`, 0);
  clearInterval(roundCountdownTimer);
  roundCountdownTimer = setInterval(() => {
    s -= 1;
    if (s <= 0) {
      setText(roundPopupBody, "GO!");
      setTimeout(hideRoundPopup, 500);
      clearInterval(roundCountdownTimer);
      roundCountdownTimer = null;
      return;
    }
    setText(roundPopupBody, `Starting in ${s}…`);
  }, 1000);
}

function setTeamUI(idx) {
  teamIndex = typeof idx === "number" ? idx : teamIndex;
  const team = getTeamAssets(teamIndex);
  if (team.banner) {
    if (teamBanner) teamBanner.src = team.banner;
    if (teamBannerEnd) teamBannerEnd.src = team.banner;
    if (teamTruck) teamTruck.src = team.truck;
    if (teamTruckEnd) teamTruckEnd.src = team.truck;
    setHidden(teamBanner, false);
    setHidden(teamTruck, false);
    setHidden(teamBannerEnd, false);
    setHidden(teamTruckEnd, false);
  }
  saveSession({ teamIndex });
  setText(endTeam, team.name);
}

function setPhaseUI(p) {
  phase = p || phase;
  saveSession({ phase });
  if (phase === "active") {
    canTap = true;
    if (btnTap) btnTap.disabled = false;
    setStatusDot("hidden");
  } else if (phase === "ended") {
    canTap = false;
    if (btnTap) btnTap.disabled = true;
    setStatusDot("hidden");
  } else {
    canTap = false;
    if (btnTap) btnTap.disabled = true;
    setStatusDot("red");
  }
}

function setTapUI(count) {
  taps = Math.max(0, Number(count) || 0);
  setText(tapCountEl, String(taps));
  setText(endTaps, String(taps));
  saveSession({ taps });
}

function setTapPressedVisual(pressed) {
  if (!tapImage) return;
  tapImage.src = pressed ? "./assets/Button_Inactive.png" : "./assets/Button_Active.png";
}

function goToControl() {
  setText(roomView, code || "—");
  setText(uidView, clientUid);
  setHidden(devPanel, !DEV_MODE);
  showView("control");
}

function goToEnd({ won, ttr, gtr, winningTeamLabel, isTie = false }) {
  showView("end");
  setText(endTTR, typeof ttr === "number" ? String(ttr) : "—");
  setText(endGTR, typeof gtr === "number" ? String(gtr) : "—");
  setText(endTitle, winningTeamLabel ? `GAME OVER — ${winningTeamLabel}` : "GAME OVER");
  setText(endResult, isTie ? "TIE" : won ? "YOU WIN" : "YOU LOSE");
  saveSession({ won: !!won, ttr, gtr });
}

function wsSend(obj) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function connectAndJoin({ codeIn, usernameIn, fullNameIn }) {
  if (isConnecting) return;
  isConnecting = true;

  code = normalizeCode(codeIn);
  username = (usernameIn || "").trim();
  fullName = (fullNameIn || "").trim();

  const minLen = Math.min(Math.max(3, CODE_LEN), MAX_CODE_LEN);
  if (!code || code.length < minLen) {
    isConnecting = false;
    showToast(`Please enter a valid room code (${CODE_LEN} letters).`);
    return;
  }
  if (!username) {
    isConnecting = false;
    showToast("Please enter a username.");
    return;
  }
  if (!fullName) {
    isConnecting = false;
    showToast("Please enter your full name.");
    return;
  }

  saveSession({ code, username, fullName, clientUid });
  setLoading(true, "Connecting…", "Please keep this page open.");
  setText(uidHint, `UID: ${clientUid}`);
  setHidden(uidHint, !DEV_MODE);

  try { if (ws) ws.close(); } catch {}
  ws = new WebSocket(WS_URL);

  const connectTimeout = setTimeout(() => showToast("Still connecting… please wait."), 2200);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    const saved = loadSavedSession();
    resumeToken = saved && saved.code === code && saved.username === username && saved.resumeToken ? saved.resumeToken : null;
    wsSend(
      resumeToken
        ? { type: "playerResume", code, username, fullName, resumeToken }
        : { type: "playerJoinTow", code, username, fullName }
    );
  };

  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const t = msg.type;

    if (t === "joinResult" && msg.ok === false) {
      setLoading(false); isConnecting = false; showToast(msg.message || msg.reason || "Join failed."); return;
    }
    if (t === "resumeResult" && msg.ok === false) {
      clearSession(); resumeToken = null; setLoading(false); isConnecting = false; showToast(msg.message || "Session expired. Please join again."); showView("input"); return;
    }
    if (t === "error" || msg.ok === false) {
      setLoading(false); isConnecting = false; showToast(msg.error || msg.message || "Connection error."); return;
    }

    if ((t === "joinResult" || t === "joined" || t === "playerJoined") && msg.ok !== false) {
      if (typeof msg.teamIndex === "number") setTeamUI(msg.teamIndex);
      if (msg.resumeToken) { resumeToken = msg.resumeToken; saveSession({ resumeToken }); }
      if (msg.phase) setPhaseUI(msg.phase);
      if (typeof msg.taps === "number") setTapUI(msg.taps);
      setLoading(false); isConnecting = false; goToControl(); return;
    }

    if ((t === "resumeResult" || t === "resumed" || t === "playerResumed") && msg.ok !== false) {
      if (typeof msg.teamIndex === "number") setTeamUI(msg.teamIndex);
      if (msg.resumeToken) { resumeToken = msg.resumeToken; saveSession({ resumeToken }); }
      if (msg.phase) setPhaseUI(msg.phase);
      if (typeof msg.taps === "number") setTapUI(msg.taps);
      setLoading(false); isConnecting = false; goToControl(); return;
    }

    if (t === "phase") { if (msg.phase) setPhaseUI(msg.phase); return; }
    if (t === "paused") { setStatusDot("orange"); setPhaseUI("join"); return; }

    if (t === "ended") {
      setPhaseUI("ended");
      goToEnd({ won: false, ttr: null, gtr: null, isTie: String(msg?.result || "").toLowerCase() === "tie" });
      return;
    }

    if (t === "roundEnd") {
      hasSeenRoundEnd = true;
      showRoundPopup(String(msg.result || "").toLowerCase() === "won" ? "ROUND WON!" : "ROUND LOST!", "Please wait for next round…", 2200);
      canTap = false;
      if (btnTap) btnTap.disabled = true;
      return;
    }

    if (t === "roundStarting") {
      if (!hasSeenRoundEnd) return;
      showRoundCountdown(Number(msg.bufferSeconds ?? msg.seconds ?? 3));
      canTap = false;
      if (btnTap) btnTap.disabled = true;
      return;
    }

    if (t === "roundLive") {
      hideRoundPopup();
      if (phase === "active") {
        canTap = true;
        if (btnTap) btnTap.disabled = false;
      }
      return;
    }

    if (t === "gameResult") {
      if (typeof msg.taps === "number") setTapUI(msg.taps);
      const st = String(msg.state || "").toLowerCase();
      goToEnd({
        won: st === "winner" || st === "win" || st === "won" || st === "victory",
        isTie: st === "tie",
        ttr: typeof msg.ttr === "number" ? msg.ttr : null,
        gtr: typeof msg.gtr === "number" ? msg.gtr : null,
        winningTeamLabel: msg.winningTeam ? String(msg.winningTeam) : null,
      });
      return;
    }

    if (t === "tap" && typeof msg.taps === "number") setTapUI(msg.taps);
  };

  ws.onerror = () => { setLoading(false); isConnecting = false; showToast("WebSocket error. Check connection / URL."); };
  ws.onclose = () => {
    if (phase !== "ended" && resumeToken && code && username) {
      setTimeout(() => {
        if (!ws || ws.readyState === 1) return;
        connectAndJoin({ codeIn: code, usernameIn: username, fullNameIn: fullName });
      }, 600);
    }
  };
}

function queueTap(amount) {
  if (!canTap) return;
  const inc = Math.max(1, Number(amount) || 1);
  tapBuffer += inc;
  setTapUI(taps + inc);
  if (!tapFlushTimer) tapFlushTimer = setTimeout(flushTaps, 90);
}
function flushTaps() {
  tapFlushTimer = null;
  if (!tapBuffer) return;
  if (!ws || ws.readyState !== 1) { tapBuffer = 0; return; }
  wsSend({ type: "playerMsg", code, username, payload: { kind: "tap", count: tapBuffer } });
  tapBuffer = 0;
}

function boot() {
  setText(uidHint, `UID: ${clientUid}`);
  setHidden(uidHint, !DEV_MODE);
  setText(uidView, clientUid);

  if (codeLabelEl) setText(codeLabelEl, "Room Code");
  if (roomCodeEl) roomCodeEl.maxLength = String(MAX_CODE_LEN);

  const urlCode = parseCodeFromUrl();
  if (roomCodeEl && urlCode) roomCodeEl.value = urlCode;
  setHidden(roomCodeWrapEl, !!urlCode);

  const saved = loadSavedSession();
  if (usernameEl && saved?.username) usernameEl.value = saved.username;
  if (fullNameEl && saved?.fullName) fullNameEl.value = saved.fullName;
  if (roomCodeEl && !roomCodeEl.value && saved?.code) roomCodeEl.value = normalizeCode(saved.code);

  if (roomCodeEl) roomCodeEl.addEventListener("input", () => { roomCodeEl.value = normalizeCode(roomCodeEl.value); });
  if (btnJoin) {
    btnJoin.addEventListener("click", () =>
      connectAndJoin({
        codeIn: roomCodeEl?.value || "",
        usernameIn: usernameEl?.value || "",
        fullNameIn: fullNameEl?.value || "",
      })
    );
  }

  [roomCodeEl, usernameEl, fullNameEl].forEach((el) => {
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btnJoin?.click();
      }
    });
  });

  if (btnTap) {
    const tapHandler = (e) => {
      if (e) e.preventDefault();
      queueTap(1);
      if (pressTimer) clearTimeout(pressTimer);
      setTapPressedVisual(true);
      pressTimer = setTimeout(() => {
        setTapPressedVisual(false);
        pressTimer = null;
      }, PRESS_FEEDBACK_MS);
    };

    btnTap.addEventListener("click", tapHandler);
    btnTap.addEventListener("touchstart", tapHandler, { passive: false });
  }

  if (btnRestart) {
    btnRestart.addEventListener("click", () => {
      clearSession();
      phase = "join"; canTap = false; taps = 0; teamIndex = null; resumeToken = null;
      hideRoundPopup();
      try { if (ws) ws.close(); } catch {}
      ws = null;
      setTapUI(0);
      setPhaseUI("join");
      setTapPressedVisual(false);
      const urlCode2 = parseCodeFromUrl();
      if (roomCodeEl) roomCodeEl.value = urlCode2 || "";
      showView("input");
    });
  }

  showView("input");
  setLoading(false);
  setPhaseUI("join");
  setHidden(devPanel, !DEV_MODE);
}

boot();
