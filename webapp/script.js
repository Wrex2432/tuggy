/* Truck Of War — Player Controller
   - Input → Loading → Control → End
   - Persistent uid + resumeToken
   - QR link auto-fills room code
   - Sends taps ONLY when server phase === "active" (backend authoritative)
   - Robust DOM null-guards (won’t crash if an element is missing)
   - Supports round popups (ROUND WON/LOST, NEXT ROUND countdown) using:
       roundEnd, roundStarting, roundLive (from truckofwar.js)
*/

"use strict";

/** =========================
 *  CONFIG
 *  ========================= */
const WS_URL = "wss://api.prologuebymetama.com/ws";

const DEFAULT_CODE_LEN = 4;
const MAX_CODE_LEN = 8;

/** Storage keys */
const K_UID = "tow.uid";
const K_SESSION = "tow.session"; // { code, username, resumeToken, teamIndex, phase, taps, ttr, gtr, won }

/** =========================
 *  DOM helpers (safe)
 *  ========================= */
function $(id) {
  return document.getElementById(id);
}
function setText(el, text) {
  if (!el) return;
  el.textContent = text;
}
function setHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle("hidden", !!hidden);
}
function setAttr(el, k, v) {
  if (!el) return;
  el.setAttribute(k, v);
}

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
const btnJoin = $("btnJoin");

const teamPill = $("teamPill");
const statusPill = $("statusPill");
const btnTap = $("btnTap");
const tapCountEl = $("tapCount");
const roomView = $("roomView");
const subhint = $("subhint");

const endTitle = $("endTitle");
const endResult = $("endResult");
const endTeam = $("endTeam");
const endTaps = $("endTaps");
const endTTR = $("endTTR");
const endGTR = $("endGTR");
const btnRestart = $("btnRestart");
const leaderboardWrap = $("leaderboardWrap");
const leaderboardList = $("leaderboardList");

/** =========================
 *  State
 *  ========================= */
let ws = null;
let isConnecting = false;

let phase = "join"; // join | active | ended
let teamIndex = null; // 0/1
let taps = 0;

let code = "";
let username = "";
let resumeToken = null;

let canTap = false;

/** Tap batching */
let tapBuffer = 0;
let tapFlushTimer = null;

/** round popup countdown timer */
let roundPopupTimer = null;
let roundCountdownTimer = null;
let hasSeenRoundEnd = false;

/** =========================
 *  UID
 *  ========================= */
function getOrCreateUid() {
  let uid = localStorage.getItem(K_UID);
  if (uid) return uid;

  if (window.crypto && crypto.randomUUID) {
    uid = crypto.randomUUID();
  } else {
    uid =
      "uid_" +
      Math.random().toString(16).slice(2) +
      "_" +
      Date.now().toString(16);
  }

  localStorage.setItem(K_UID, uid);
  return uid;
}

const clientUid = getOrCreateUid();

/** =========================
 *  Session persistence
 *  ========================= */
function loadSavedSession() {
  try {
    const raw = localStorage.getItem(K_SESSION);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSession(patch) {
  const prev = loadSavedSession() || {};
  const next = { ...prev, ...patch };
  localStorage.setItem(K_SESSION, JSON.stringify(next));
  return next;
}

function clearSession() {
  localStorage.removeItem(K_SESSION);
}

/** =========================
 *  URL helpers
 *  ========================= */
function getCodeLenFromUrlOrDefault() {
  try {
    const u = new URL(window.location.href);
    const raw = (u.searchParams.get("len") || "").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 3 && n <= MAX_CODE_LEN) return n;
  } catch {}
  return DEFAULT_CODE_LEN;
}
const CODE_LEN = getCodeLenFromUrlOrDefault();

function parseCodeFromUrl() {
  const u = new URL(window.location.href);
  const cd = (u.searchParams.get("cd") || "").trim();
  if (cd) return normalizeCode(cd);

  const q = (u.searchParams.get("code") || "").trim();
  if (q) return normalizeCode(q);

  const parts = u.pathname.split("/").filter(Boolean);
  if (!parts.length) return "";
  const last = parts[parts.length - 1];

  if (/^[a-zA-Z]{3,8}$/.test(last)) return normalizeCode(last);
  return "";
}

function normalizeCode(v) {
  return (v || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, MAX_CODE_LEN);
}

/** =========================
 *  UI
 *  ========================= */
function showView(which) {
  if (viewInput) viewInput.classList.add("hidden");
  if (viewControl) viewControl.classList.add("hidden");
  if (viewEnd) viewEnd.classList.add("hidden");

  if (which === "input" && viewInput) viewInput.classList.remove("hidden");
  if (which === "control" && viewControl) viewControl.classList.remove("hidden");
  if (which === "end" && viewEnd) viewEnd.classList.remove("hidden");
}

function setLoading(on, title, sub) {
  if (loading) {
    loading.classList.toggle("hidden", !on);
    setAttr(loading, "aria-hidden", on ? "false" : "true");
  }
  if (title) setText(loadingTitleEl, title);
  if (sub) setText(loadingSubEl, sub);
}

let toastTimer = null;
function showToast(msg) {
  if (!toast || !toastText) return;
  toastText.textContent = msg || "Something went wrong.";
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2400);
}

function setStatusDot(mode) {
  // mode: "hidden" | "red" | "orange"
  if (!statusDot) return;
  statusDot.classList.remove("hidden");
  statusDot.classList.remove("is-red", "is-orange");

  if (!mode || mode === "hidden") {
    statusDot.classList.add("hidden");
    return;
  }
  if (mode === "red") statusDot.classList.add("is-red");
  if (mode === "orange") statusDot.classList.add("is-orange");
}

function showRoundPopup(title, body, ms) {
  if (!roundPopup) return;

  clearTimeout(roundPopupTimer);
  clearInterval(roundCountdownTimer);

  setText(roundPopupTitle, title || "ROUND");
  setText(roundPopupBody, body || "");
  setHidden(roundPopup, false);
  setAttr(roundPopup, "aria-hidden", "false");

  if (typeof ms === "number" && ms > 0) {
    roundPopupTimer = setTimeout(() => {
      hideRoundPopup();
    }, ms);
  }
}

function hideRoundPopup() {
  if (!roundPopup) return;
  clearTimeout(roundPopupTimer);
  clearInterval(roundCountdownTimer);
  setHidden(roundPopup, true);
  setAttr(roundPopup, "aria-hidden", "true");
}

function showRoundCountdown(seconds) {
  if (!roundPopup) return;

  let s = Math.max(0, Number(seconds) || 0);
  showRoundPopup("NEXT ROUND", `Starting in ${s}…`, 0);

  clearInterval(roundCountdownTimer);
  roundCountdownTimer = setInterval(() => {
    s -= 1;
    if (s <= 0) {
      setText(roundPopupBody, "GO!");
      setTimeout(() => hideRoundPopup(), 500);
      clearInterval(roundCountdownTimer);
      roundCountdownTimer = null;
      return;
    }
    setText(roundPopupBody, `Starting in ${s}…`);
  }, 1000);
}

function setTeamUI(idx) {
  teamIndex = typeof idx === "number" ? idx : teamIndex;
  const label = teamIndex === 0 ? "TEAM A" : teamIndex === 1 ? "TEAM B" : "TEAM —";
  setText(teamPill, label);
  saveSession({ teamIndex });
}

function setPhaseUI(p) {
  phase = p || phase;
  saveSession({ phase });

  if (phase === "active") {
    setText(statusPill, "PLAY");
    setText(subhint, "Tap as fast as you can!");
    canTap = true;
    if (btnTap) btnTap.disabled = false;
    setStatusDot("hidden");
  } else if (phase === "ended") {
    setText(statusPill, "ENDED");
    setText(subhint, "Game ended.");
    canTap = false;
    if (btnTap) btnTap.disabled = true;
    setStatusDot("hidden");
  } else {
    setText(statusPill, "WAITING");
    setText(subhint, "Waiting for the game to start…");
    canTap = false;
    if (btnTap) btnTap.disabled = true;
    setStatusDot("red");
  }
}

function setTapUI(count) {
  taps = Math.max(0, Number(count) || 0);
  setText(tapCountEl, String(taps));
  saveSession({ taps });
}

function goToControl() {
  setText(roomView, code || "—");
  showView("control");
}

function goToEnd({ won, ttr, gtr, winningTeamLabel, isTie = false }) {
  showView("end");

  const teamLabel =
    teamIndex === 0 ? "TEAM A" : teamIndex === 1 ? "TEAM B" : "TEAM —";
  setText(endTeam, teamLabel);
  setText(endTaps, String(taps));
  setText(endTTR, typeof ttr === "number" ? String(ttr) : "—");
  setText(endGTR, typeof gtr === "number" ? String(gtr) : "—");

  if (winningTeamLabel) setText(endTitle, `GAME OVER — ${winningTeamLabel}`);
  else setText(endTitle, "GAME OVER");

  if (isTie) setText(endResult, "TIE");
  else setText(endResult, won ? "YOU WIN" : "YOU LOSE");

  saveSession({ won: !!won, ttr, gtr });
}

/** =========================
 *  WebSocket
 *  ========================= */
function wsSend(obj) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function connectAndJoin({ codeIn, usernameIn }) {
  if (isConnecting) return;
  isConnecting = true;

  code = normalizeCode(codeIn);
  username = (usernameIn || "").trim();

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

  saveSession({ code, username, clientUid });

  setLoading(true, "Connecting…", "Please keep this page open.");
  if (uidHint) {
    setText(uidHint, `UID: ${clientUid}`);
    setHidden(uidHint, true);
  }

  try {
    if (ws) ws.close();
  } catch {}
  ws = null;

  ws = new WebSocket(WS_URL);

  const connectTimeout = setTimeout(() => {
    showToast("Still connecting… please wait.");
  }, 2200);

  ws.onopen = () => {
    clearTimeout(connectTimeout);

    const saved = loadSavedSession();
    const savedToken =
      saved &&
      saved.code === code &&
      saved.username === username &&
      saved.resumeToken
        ? saved.resumeToken
        : null;

    resumeToken = savedToken;

    if (resumeToken) {
      // IMPORTANT: server expects code + username + resumeToken
      wsSend({
        type: "playerResume",
        code,
        username,
        resumeToken,
      });
    } else {
      wsSend({
        type: "playerJoinTow",
        code,
        username,
      });
    }
  };

  ws.onmessage = (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    const t = msg.type;

    // --- backend structured errors ---
    if (t === "joinResult" && msg.ok === false) {
      setLoading(false);
      isConnecting = false;
      showToast(msg.message || msg.reason || "Join failed.");
      return;
    }
    if (t === "resumeResult" && msg.ok === false) {
      // token invalid → clear and force rejoin
      clearSession();
      resumeToken = null;
      setLoading(false);
      isConnecting = false;
      showToast(msg.message || "Session expired. Please join again.");
      showView("input");
      return;
    }

    // generic error wrapper
    if (t === "error" || msg.ok === false) {
      setLoading(false);
      isConnecting = false;
      showToast(msg.error || msg.message || "Connection error.");
      return;
    }

    // --- join / resume acknowledgements ---
    if ((t === "joinResult" || t === "joined" || t === "playerJoined") && msg.ok !== false) {
      if (typeof msg.teamIndex === "number") setTeamUI(msg.teamIndex);
      if (msg.resumeToken) {
        resumeToken = msg.resumeToken;
        saveSession({ resumeToken });
      }
      if (msg.phase) setPhaseUI(msg.phase);
      if (typeof msg.taps === "number") setTapUI(msg.taps);

      setLoading(false);
      isConnecting = false;
      goToControl();
      return;
    }

    if ((t === "resumeResult" || t === "resumed" || t === "playerResumed") && msg.ok !== false) {
      if (typeof msg.teamIndex === "number") setTeamUI(msg.teamIndex);
      if (msg.resumeToken) {
        resumeToken = msg.resumeToken;
        saveSession({ resumeToken });
      }
      if (msg.phase) setPhaseUI(msg.phase);
      if (typeof msg.taps === "number") setTapUI(msg.taps);

      setLoading(false);
      isConnecting = false;
      goToControl();
      return;
    }

    // --- phase updates ---
    if (t === "phase") {
      if (msg.phase) setPhaseUI(msg.phase);
      return;
    }

    // --- paused / ended ---
    if (t === "paused") {
      setStatusDot("orange");
      setPhaseUI("join");
      setText(statusPill, "PAUSED");
      setText(subhint, "Game paused — reconnecting…");
      if (btnTap) btnTap.disabled = true;
      canTap = false;
      return;
    }

    if (t === "ended") {
      setPhaseUI("ended");
      goToEnd({ won: false, ttr: null, gtr: null, isTie: String(msg?.result || "").toLowerCase() === "tie" });
      return;
    }

    /* =========================
       Round UX (matches truckofwar.js)
       - roundEnd: { result:"won"|"lost", roundIndex, winnerTeamIndex }
       - roundStarting: { bufferSeconds, roundIndex }
       - roundLive: { roundIndex }
    ========================= */
    if (t === "roundEnd") {
      hasSeenRoundEnd = true;
      const res = String(msg.result || "").toLowerCase();
      const title = res === "won" ? "ROUND WON!" : "ROUND LOST!";
      showRoundPopup(title, "Please wait for next round…", 2200);

      // while waiting, you can keep taps disabled until roundLive arrives (optional)
      canTap = false;
      if (btnTap) btnTap.disabled = true;
      setText(statusPill, "WAITING");
      return;
    }

    if (t === "roundStarting") {
      if (!hasSeenRoundEnd) return;
      const secs = Number(msg.bufferSeconds ?? msg.seconds ?? 3);
      showRoundCountdown(secs);

      // still disabled until roundLive
      canTap = false;
      if (btnTap) btnTap.disabled = true;
      setText(statusPill, "WAITING");
      return;
    }

    if (t === "roundLive") {
      hideRoundPopup();
      // If game phase is active, allow taps (some setups keep phase active across rounds)
      if (phase === "active") {
        canTap = true;
        if (btnTap) btnTap.disabled = false;
        setText(statusPill, "PLAY");
        setText(subhint, "Tap as fast as you can!");
      }
      return;
    }

    // --- final result ---
    if (t === "gameResult") {
      if (typeof msg.taps === "number") setTapUI(msg.taps);

      const st = String(msg.state || "").toLowerCase();
      const isTie = st === "tie";
      const won =
        st === "winner" || st === "win" || st === "won" || st === "victory";

      const winningTeamLabel = msg.winningTeam ? String(msg.winningTeam) : null;

      goToEnd({
        won,
        isTie,
        ttr: typeof msg.ttr === "number" ? msg.ttr : null,
        gtr: typeof msg.gtr === "number" ? msg.gtr : null,
        winningTeamLabel,
        leaderboard: Array.isArray(msg.topGtr) ? msg.topGtr : null,
      });
      return;
    }

    // --- tap echo (optional) ---
    if (t === "tap") {
      if (typeof msg.taps === "number") setTapUI(msg.taps);
      return;
    }
  };

  ws.onerror = () => {
    setLoading(false);
    isConnecting = false;
    showToast("WebSocket error. Check connection / URL.");
  };

  ws.onclose = () => {
    if (phase !== "ended" && resumeToken && code && username) {
      setTimeout(() => {
        if (!ws || ws.readyState === 1) return;
        connectAndJoin({ codeIn: code, usernameIn: username });
      }, 600);
    }
  };
}

/** =========================
 *  Tap sending (ONLY when active)
 *  Backend is authoritative.
 *  ========================= */
function queueTap(amount) {
  if (!canTap) return;

  const inc = Math.max(1, Number(amount) || 1);
  tapBuffer += inc;

  // optimistic UI
  setTapUI(taps + inc);

  if (!tapFlushTimer) {
    tapFlushTimer = setTimeout(flushTaps, 90);
  }
}

function flushTaps() {
  tapFlushTimer = null;
  if (!tapBuffer) return;
  if (!ws || ws.readyState !== 1) {
    tapBuffer = 0;
    return;
  }

  // IMPORTANT: include code + username for server.js routing
  wsSend({
    type: "playerMsg",
    code,
    username,
    payload: {
      kind: "tap",
      count: tapBuffer,
    },
  });

  tapBuffer = 0;
}

/** =========================
 *  Boot
 *  ========================= */
function boot() {
  if (uidHint) {
    setText(uidHint, `UID: ${clientUid}`);
    setHidden(uidHint, true);
  }

  if (codeLabelEl) setText(codeLabelEl, "Room Code");
  if (roomCodeEl) roomCodeEl.maxLength = String(MAX_CODE_LEN);

  const urlCode = parseCodeFromUrl();
  if (roomCodeEl && urlCode) roomCodeEl.value = urlCode;
  if (roomCodeWrapEl) setHidden(roomCodeWrapEl, !!urlCode);

  const saved = loadSavedSession();
  if (usernameEl && saved && saved.username) usernameEl.value = saved.username;
  if (roomCodeEl && !roomCodeEl.value && saved && saved.code) {
    roomCodeEl.value = normalizeCode(saved.code);
  }

  if (roomCodeEl && usernameEl) {
    if (roomCodeEl.value) usernameEl.focus();
    else roomCodeEl.focus();
  }

  if (roomCodeEl) {
    roomCodeEl.addEventListener("input", () => {
      roomCodeEl.value = normalizeCode(roomCodeEl.value);
    });
  }

  if (btnJoin) {
    btnJoin.addEventListener("click", () => {
      connectAndJoin({
        codeIn: roomCodeEl ? roomCodeEl.value : "",
        usernameIn: usernameEl ? usernameEl.value : "",
      });
    });
  }

  [roomCodeEl, usernameEl].forEach((el) => {
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (btnJoin) btnJoin.click();
      }
    });
  });

  if (btnTap) {
    btnTap.addEventListener("click", () => queueTap(1));
    btnTap.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        queueTap(1);
      },
      { passive: false }
    );
  }

  if (btnRestart) {
    btnRestart.addEventListener("click", () => {
      clearSession();
      phase = "join";
      canTap = false;
      taps = 0;
      teamIndex = null;
      resumeToken = null;

      hideRoundPopup();

      try {
        if (ws) ws.close();
      } catch {}
      ws = null;

      setTapUI(0);
      setPhaseUI("join");
      setText(teamPill, "TEAM —");
      setText(statusPill, "WAITING");

      const urlCode2 = parseCodeFromUrl();
      if (roomCodeEl) roomCodeEl.value = urlCode2 || "";

      showView("input");
    });
  }

  showView("input");
  setLoading(false);
  setPhaseUI("join");
}

boot();
