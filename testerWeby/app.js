"use strict";

const $ = (id) => document.getElementById(id);
const els = {
  wsUrl: $("wsUrl"),
  roomCode: $("roomCode"),
  playerCount: $("playerCount"),
  namePrefix: $("namePrefix"),
  tapMs: $("tapMs"),
  btnJoin: $("btnJoin"),
  btnLeave: $("btnLeave"),
  btnTapStart: $("btnTapStart"),
  btnTapStop: $("btnTapStop"),
  connected: $("connected"),
  joined: $("joined"),
  sentTaps: $("sentTaps"),
  log: $("log"),
};

/** @type {Array<{ws:WebSocket,username:string,joined:boolean,phase:string}>} */
let clients = [];
let tapTimer = null;
let sentTaps = 0;

function normalizeCode(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  els.log.textContent = `[${ts}] ${msg}\n` + els.log.textContent;
}

function refreshStats() {
  const connected = clients.filter((c) => c.ws.readyState === WebSocket.OPEN).length;
  const joined = clients.filter((c) => c.joined).length;
  els.connected.textContent = String(connected);
  els.joined.textContent = String(joined);
  els.sentTaps.textContent = String(sentTaps);
}

function send(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function leaveAll() {
  if (tapTimer) {
    clearInterval(tapTimer);
    tapTimer = null;
  }
  for (const c of clients) {
    try { c.ws.close(); } catch (_) {}
  }
  clients = [];
  refreshStats();
  log("All clients disconnected.");
}

function joinAll() {
  leaveAll();
  sentTaps = 0;

  const wsUrl = String(els.wsUrl.value || "").trim();
  const code = normalizeCode(els.roomCode.value);
  const count = Math.max(1, Math.min(100, Number(els.playerCount.value) || 1));
  const prefix = String(els.namePrefix.value || "bot").trim() || "bot";

  if (!code) {
    log("Room code required.");
    return;
  }

  for (let i = 1; i <= count; i++) {
    const username = `${prefix}${String(i).padStart(2, "0")}`;
    const ws = new WebSocket(wsUrl);
    const client = { ws, username, joined: false, phase: "join" };
    clients.push(client);

    ws.onopen = () => {
      send(ws, { type: "playerJoinTow", code, username });
      refreshStats();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === "joinResult") {
        client.joined = !!msg.ok;
        if (!msg.ok) {
          log(`${username} join failed: ${msg.reason || "unknown"}`);
        }
      }
      if (msg.type === "phase" && msg.phase) client.phase = String(msg.phase);
      if (msg.type === "gameResult") {
        log(`${username} -> ${msg.state || "result"} (${msg.winningTeam || "?"})`);
      }
      refreshStats();
    };

    ws.onclose = () => {
      client.joined = false;
      refreshStats();
    };

    ws.onerror = () => log(`${username} socket error`);
  }

  log(`Spawned ${count} simulated players for room ${code}.`);
}

function startAutoTap() {
  const interval = Math.max(20, Number(els.tapMs.value) || 120);
  const code = normalizeCode(els.roomCode.value);

  if (tapTimer) clearInterval(tapTimer);
  tapTimer = setInterval(() => {
    for (const c of clients) {
      if (!c.joined || c.phase !== "active") continue;
      send(c.ws, {
        type: "playerMsg",
        code,
        username: c.username,
        payload: { kind: "tap", count: 1 },
      });
      sentTaps += 1;
    }
    refreshStats();
  }, interval);

  log(`Auto-tap started at ${interval}ms interval.`);
}

function stopAutoTap() {
  if (tapTimer) clearInterval(tapTimer);
  tapTimer = null;
  log("Auto-tap stopped.");
}

els.btnJoin.addEventListener("click", joinAll);
els.btnLeave.addEventListener("click", leaveAll);
els.btnTapStart.addEventListener("click", startAutoTap);
els.btnTapStop.addEventListener("click", stopAutoTap);

window.addEventListener("beforeunload", leaveAll);
refreshStats();
