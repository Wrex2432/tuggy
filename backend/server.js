// server.js
// Central WebSocket backend for all games (Flavor Frenzy / popcorn adapter etc.)

const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // you can later lock this to your prod domain
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// --- helpers ---
function lettersOnly(str) {
  return (str || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 8);
}

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch (_) {}
}

function broadcastToPlayers(session, msgObj) {
  const asStr = JSON.stringify(msgObj);
  for (const [pid, p] of Object.entries(session.players)) {
    try {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(asStr);
      }
    } catch (_) {}
  }
}

function nowMs() {
  return Date.now();
}

// --- state ---
const sessions = new Map(); // code -> session

// load adapters
const adapters = {
  popcorn: require(path.join(__dirname, "games", "popcorn.js")),
  truckofwar: require(path.join(__dirname, "games", "truckofwar.js")), // NEW
};

// create server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // --- CORS preflight (for safety) ---
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...CORS_HEADERS,
    });
    return res.end();
  }

  // --- /game-status endpoint for catchup-state.js ---
  if (path === "/game-status" && req.method === "GET") {
    const code = url.searchParams.get("code") || "";
    const username = (url.searchParams.get("username") || "").trim();

    const cleanCode = lettersOnly(code);
    const session = sessions.get(cleanCode);

    if (!session) {
      const body = JSON.stringify({
        ok: false,
        error: "code_not_found",
        phase: null,
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      });
      return res.end(body);
    }

    // phase comes directly from the session: "join" | "active" | "ended"
    const phase = session.phase || "join";

    // Optional: look up player info (not required for catchup, but nice to have)
    let playerInfo = null;
    if (username) {
      const found = findPlayerByUsername(session, username.toLowerCase());
      if (found && found.player) {
        playerInfo = {
          username: found.player.username,
          teamIndex: found.player.teamIndex ?? null,
        };
      }
    }

    const body = JSON.stringify({
      ok: true,
      code: session.code,
      phase, // <--- catchup-state.js reads this
      player: playerInfo,
      // You could also include snapshot if you want:
      // snapshot: adapters[session.gameType].snapshot(session),
    });

    res.writeHead(200, {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    });
    return res.end(body);
  }

  // --- Default response for other paths ---
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    ...CORS_HEADERS,
  });
  res.end("OK");
});

const wss = new WebSocket.Server({ server });

// Grace period (ms) after game ends before we actually kill the whole session
const END_GRACE_MS = 300_000;

// Grace period (ms) after UNITY disconnects before we kill the session
// (allows Unity to reconnect without instantly ending the game)
const UNITY_DISCONNECT_GRACE_MS = 120_000;

// kill a session (called when Unity disconnects *after* grace or after game-end cleanup)
function endSession(session) {
  if (!session) return;

  // NEW: TruckOfWar-only hook before teardown (best-effort)
  try {
    const adapter = adapters[session.gameType];
    if (
      session.gameType === "truckofwar" &&
      adapter &&
      typeof adapter.onSessionEnd === "function"
    ) {
      adapter.onSessionEnd(session, { reason: "endSession" });
    }
  } catch (_) {}
  // NEW: end TruckOfWar-only hook

  // Clear any pending Unity timeout handle
  if (session.unityTimeoutHandle) {
    clearTimeout(session.unityTimeoutHandle);
    session.unityTimeoutHandle = null;
  }

  // Notify players that it's over
  broadcastToPlayers(session, { type: "ended" });

  // Close all player sockets
  for (const [pid, p] of Object.entries(session.players)) {
    try {
      p.ws.close();
    } catch (_) {}
  }

  // Close unity socket
  try {
    if (session.unity?.ws) {
      session.unity.ws.close();
    }
  } catch (_) {}

  sessions.delete(session.code);
}

// Attempt deferred cleanup after a game ends
function maybeScheduleCleanup(session) {
  if (!session) return;
  session.lastResultAt = nowMs();
  setTimeout(() => {
    // If session still exists and is in "ended" for a while, nuke it
    const still = sessions.get(session.code);
    if (!still) return;
    // If unity is already gone OR ended long enough, end it
    const delta = nowMs() - (still.lastResultAt || 0);
    const unityGone =
      !still.unity ||
      !still.unity.ws ||
      still.unity.ws.readyState !== WebSocket.OPEN;
    if (unityGone || delta >= END_GRACE_MS) {
      endSession(still);
    }
  }, END_GRACE_MS + 1000);
}

// Schedule a timeout when UNITY disconnects mid-game.
// If Unity doesn't reconnect within the grace window, end the session.
function scheduleUnityTimeout(session) {
  if (!session) return;
  // Avoid multiple timers
  if (session.unityTimeoutHandle) return;

  session.unityDisconnectedAt = nowMs();
  session.unityTimeoutHandle = setTimeout(() => {
    const current = sessions.get(session.code);
    if (!current) return;

    // If Unity has reconnected, cancel shutdown
    if (
      current.unity &&
      current.unity.ws &&
      current.unity.ws.readyState === WebSocket.OPEN
    ) {
      current.unityTimeoutHandle = null;
      return;
    }

    // NEW: TruckOfWar-only forced-end hook.
    // Let adapter compute winner + send gameResult before teardown.
    try {
      const adapter = adapters[current.gameType];
      if (
        current.gameType === "truckofwar" &&
        adapter &&
        typeof adapter.onForcedEnd === "function"
      ) {
        Promise.resolve(
          adapter.onForcedEnd(current, { reason: "unity_disconnected_timeout" })
        )
          .catch(() => {})
          .finally(() => {
            endSession(current);
          });
        return;
      }
    } catch (_) {}
    // NEW: end TruckOfWar-only forced-end hook

    // Unity still gone after grace → end session
    if (current.phase !== "ended") {
      broadcastToPlayers(current, {
        type: "ended",
        reason: "unity_disconnected_timeout",
      });
    }

    endSession(current);
  }, UNITY_DISCONNECT_GRACE_MS);
}

// Find an active player by username (case-insensitive)
function findPlayerByUsername(session, unameLower) {
  for (const [cid, p] of Object.entries(session.players)) {
    if (p.username && p.username.toLowerCase() === unameLower) {
      return { clientId: cid, player: p };
    }
  }
  return null;
}

// -------------- WebSocket connection handling --------------
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.role = null; // "unity" or "player"
  ws.sessionCode = null;
  ws.clientId = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    // ROUTING:
    // Unity creates session (or reattaches to existing one)
    if (msg.type === "unityCreate") {
      const {
        gameType,
        location,
        teamCount,
        allowedNumberOfPlayers,
        requestedCode,
        voucherPool, // may be undefined / omitted now, that's fine
        teamA_name,
        teamB_name,
        teamA_playerSeat,
        teamB_playerSeat,
        // optional team assignment mode from control.json
        teamAssignmentMode: _teamAssignmentModeIncoming,
        // NEW: tier config from control.json
        winTopUnderStart,
        winTopUnderMax,
      } = msg;

      // sanitize/validate teamAssignmentMode, default to "roundRobin"
      let teamAssignmentMode = (_teamAssignmentModeIncoming || "roundRobin")
        .toString()
        .trim();
      const VALID_TEAM_MODES = new Set(["roundRobin", "seatPinned"]);
      if (!VALID_TEAM_MODES.has(teamAssignmentMode)) {
        teamAssignmentMode = "roundRobin";
      }

      const codeCandidate = lettersOnly(requestedCode);
      if (!codeCandidate) {
        safeSend(ws, {
          type: "unityCreated",
          ok: false,
          reason: "invalid_code",
        });
        return;
      }

      // If a session with this code already exists, attempt UNITY reattach
      const existing = sessions.get(codeCandidate);
      if (existing) {
        const existingUnityOpen =
          existing.unity &&
          existing.unity.ws &&
          existing.unity.ws.readyState === WebSocket.OPEN;

        if (existingUnityOpen) {
          // Another Unity is already controlling this session
          safeSend(ws, {
            type: "unityCreated",
            ok: false,
            reason: "code_in_use",
          });
          return;
        }

        // Session exists but Unity is gone → let this Unity reattach
        // For safety, require matching gameType + location
        if (existing.gameType !== gameType || existing.location !== location) {
          safeSend(ws, {
            type: "unityCreated",
            ok: false,
            reason: "session_mismatch",
          });
          return;
        }

        existing.unity = { ws };
        ws.role = "unity";
        ws.sessionCode = existing.code;

        // Clear any pending Unity-timeout
        if (existing.unityTimeoutHandle) {
          clearTimeout(existing.unityTimeoutHandle);
          existing.unityTimeoutHandle = null;
        }
        existing.unityDisconnectedAt = null;

        console.log(`[session ${existing.code}] UNITY reconnected`);
        safeSend(ws, {
          type: "unityCreated",
          ok: true,
          code: existing.code,
          snapshot: adapters[existing.gameType].snapshot(existing),
          reattached: true,
        });
        return;
      }

      const adapter = adapters[gameType];
      if (!adapter) {
        safeSend(ws, {
          type: "unityCreated",
          ok: false,
          reason: "unknown_gameType",
        });
        return;
      }

      // Build base session
      const session = {
        code: codeCandidate,
        gameType,
        location,
        teamCount,
        allowedNumberOfPlayers,
        voucherPool: Array.isArray(voucherPool) ? [...voucherPool] : [],
        teamA_name: teamA_name || "TEAM A",
        teamB_name: teamB_name || "TEAM B",
        teamA_playerSeat: Array.isArray(teamA_playerSeat)
          ? [...teamA_playerSeat]
          : [],
        teamB_playerSeat: Array.isArray(teamB_playerSeat)
          ? [...teamB_playerSeat]
          : [],
        teamAssignmentMode, // "roundRobin" | "seatPinned"

        // store tier range config (as raw values; adapter will parse)
        winTopUnderStart: winTopUnderStart,
        winTopUnderMax: winTopUnderMax,

        phase: "join", // "join" | "active" | "ended"
        unity: { ws },
        players: {}, // clientId -> { ws, username, seat, teamIndex, resumeToken }
        state: null, // adapter-managed
        lastResultAt: null,

        // resume index (token -> minimal identity)
        resumables: {}, // token -> { username, seat, teamIndex }

        // Unity disconnect tracking
        unityDisconnectedAt: null,
        unityTimeoutHandle: null,
      };

      // Let adapter init its state (pass all relevant config)
      session.state = adapter.onInit({
        code: session.code,
        teamCount: session.teamCount,
        allowedNumberOfPlayers: session.allowedNumberOfPlayers,
        voucherPool: session.voucherPool,
        teamA_name: session.teamA_name,
        teamB_name: session.teamB_name,
        teamA_playerSeat: session.teamA_playerSeat,
        teamB_playerSeat: session.teamB_playerSeat,
        teamAssignmentMode: session.teamAssignmentMode,
        // pass win-tier configuration to adapter
        winTopUnderStart: session.winTopUnderStart,
        winTopUnderMax: session.winTopUnderMax,
      });

      sessions.set(session.code, session);

      ws.role = "unity";
      ws.sessionCode = session.code;

      console.log(
        `[session ${session.code}] game=${gameType} teams=${teamCount} mode=${session.teamAssignmentMode}`
      );

      // Give Unity confirmation + snapshot
      safeSend(ws, {
        type: "unityCreated",
        ok: true,
        code: session.code,
        snapshot: adapter.snapshot(session),
      });
      return;
    }

    // PLAYER JOINS GAME
    if (msg.type === "playerJoin") {
      const { code, username, seat } = msg;
      const cleanCode = lettersOnly(code || "");
      const uname = (username || "").trim();
      const seatId = (seat || "").trim().toUpperCase();

      const session = sessions.get(cleanCode);
      if (!session) {
        safeSend(ws, {
          type: "joinResult",
          ok: false,
          reason: "code_not_found",
        });
        return;
      }

      // Enforce join-phase only (resume bypasses this; see playerResume)
      if (session.phase !== "join") {
        safeSend(ws, {
          type: "joinResult",
          ok: false,
          reason: "game_started",
        });
        return;
      }

      // sanity checks
      if (!uname) {
        safeSend(ws, {
          type: "joinResult",
          ok: false,
          reason: "missing_username",
        });
        return;
      }
      // cap check
      const totalPlayers = Object.keys(session.players).length;
      if (totalPlayers >= session.allowedNumberOfPlayers) {
        safeSend(ws, {
          type: "joinResult",
          ok: false,
          reason: "player_cap_reached",
        });
        return;
      }
      // duplicate username check (case-insensitive)
      const unameLower = uname.toLowerCase();
      for (const p of Object.values(session.players)) {
        if (p.username.toLowerCase() === unameLower) {
          safeSend(ws, {
            type: "joinResult",
            ok: false,
            reason: "duplicate_username",
          });
          return;
        }
      }

      // OK, attach this player to session
      const clientId = uuidv4();
      const resumeToken = uuidv4();
      ws.role = "player";
      ws.sessionCode = session.code;
      ws.clientId = clientId;

      session.players[clientId] = {
        ws,
        username: uname,
        seat: seatId,
        teamIndex: null, // will be filled by adapter
        resumeToken,
      };

      // Let adapter finalize: assign team, broadcast snapshots, etc.
      adapters[session.gameType].onPlayerJoin(session, clientId, seatId);

      // Store resumable identity (username + seat + team)
      const teamIndex = session.players[clientId].teamIndex;
      session.resumables[resumeToken] = {
        username: uname,
        seat: seatId || null,
        teamIndex: teamIndex,
      };

      // Tell the client they joined successfully (+ give resume token)
      safeSend(ws, { type: "joinResult", ok: true, teamIndex, resumeToken });

      // Finally, push full snapshot to this player so they have context
      safeSend(ws, {
        type: "state",
        snapshot: adapters[session.gameType].snapshot(session),
      });

      return;
    }

    // NEW: Truck Of War late-join (allowed during "join" OR "active"; blocked only when "ended")
    if (msg.type === "playerJoinTow") {
      const { code, username, seat } = msg;
      const cleanCode = lettersOnly(code || "");
      const uname = (username || "").trim();
      const seatId = (seat || "").trim().toUpperCase();

      const session = sessions.get(cleanCode);
      if (!session) {
        safeSend(ws, { type: "joinResult", ok: false, reason: "code_not_found" });
        return;
      }

      if (session.gameType !== "truckofwar") {
        safeSend(ws, { type: "joinResult", ok: false, reason: "wrong_gameType" });
        return;
      }

      if (session.phase === "ended") {
        safeSend(ws, { type: "joinResult", ok: false, reason: "game_ended" });
        return;
      }

      if (!uname) {
        safeSend(ws, {
          type: "joinResult",
          ok: false,
          reason: "missing_username",
        });
        return;
      }

      const totalPlayers = Object.keys(session.players).length;
      if (totalPlayers >= session.allowedNumberOfPlayers) {
        safeSend(ws, {
          type: "joinResult",
          ok: false,
          reason: "player_cap_reached",
        });
        return;
      }

      const unameLower = uname.toLowerCase();
      for (const p of Object.values(session.players)) {
        if (p.username.toLowerCase() === unameLower) {
          safeSend(ws, {
            type: "joinResult",
            ok: false,
            reason: "duplicate_username",
          });
          return;
        }
      }

      const clientId = uuidv4();
      const resumeToken = uuidv4();
      ws.role = "player";
      ws.sessionCode = session.code;
      ws.clientId = clientId;

      session.players[clientId] = {
        ws,
        username: uname,
        seat: seatId,
        teamIndex: null, // will be filled by adapter
        resumeToken,
      };

      adapters[session.gameType].onPlayerJoin(session, clientId, seatId);

      const teamIndex = session.players[clientId].teamIndex;
      session.resumables[resumeToken] = {
        username: uname,
        seat: seatId || null,
        teamIndex: teamIndex,
      };

      safeSend(ws, {
        type: "joinResult",
        ok: true,
        teamIndex,
        resumeToken,
        phase: session.phase,
      });

      safeSend(ws, {
        type: "state",
        snapshot: adapters[session.gameType].snapshot(session),
      });

      return;
    }
    // NEW: end playerJoinTow

    // PLAYER RESUME (reconnect after accidental close/refresh)
    if (msg.type === "playerResume") {
      const { code, resumeToken } = msg;
      const cleanCode = lettersOnly(code || "");
      const session = sessions.get(cleanCode);
      if (!session) {
        safeSend(ws, {
          type: "resumeResult",
          ok: false,
          reason: "code_not_found",
        });
        return;
      }
      const entry = session.resumables[resumeToken];
      if (!resumeToken || !entry) {
        safeSend(ws, {
          type: "resumeResult",
          ok: false,
          reason: "invalid_token",
        });
        return;
      }

      // If someone with same username is still connected, evict the stale socket
      const unameLower = entry.username.toLowerCase();
      const existingPlayer = findPlayerByUsername(session, unameLower);
      if (existingPlayer) {
        try {
          adapters[session.gameType].onPlayerLeave(
            session,
            existingPlayer.clientId
          );
        } catch (_) {}
        delete session.players[existingPlayer.clientId];
        try {
          existingPlayer.player.ws?.close();
        } catch (_) {}
      }

      // Attach as a new player record using the saved identity
      const clientId = uuidv4();
      ws.role = "player";
      ws.sessionCode = session.code;
      ws.clientId = clientId;

      session.players[clientId] = {
        ws,
        username: entry.username,
        seat: entry.seat || "",
        teamIndex: entry.teamIndex, // keep the SAME team
        resumeToken,
      };

      // Tell adapter about a resume (so it can repopulate rosters + notify Unity)
      if (typeof adapters[session.gameType].onPlayerResume === "function") {
        adapters[session.gameType].onPlayerResume(session, clientId, entry);
      } else {
        // Fallback: emulate join with forced team (minimal)
        const p = session.players[clientId];
        try {
          adapters[session.gameType].onPlayerLeave(session, clientId);
        } catch (_) {}
        const fakeSeat = entry.seat || null;
        adapters[session.gameType].onPlayerJoin(session, clientId, fakeSeat);
        p.teamIndex = entry.teamIndex;
      }

      // Acknowledge to the client
      safeSend(ws, {
        type: "resumeResult",
        ok: true,
        username: entry.username,
        seat: entry.seat || null,
        teamIndex: entry.teamIndex,
        phase: session.phase,
      });

      // Give fresh snapshot for UI
      safeSend(ws, {
        type: "state",
        snapshot: adapters[session.gameType].snapshot(session),
      });

      return;
    }

    // UNITY -> ADAPTER MESSAGES
    if (msg.type === "unityMsg") {
      const { code, payload } = msg;
      const session = sessions.get(lettersOnly(code || ""));
      if (!session) return;
      if (session.unity?.ws !== ws) return; // ensure it's actually that session's Unity

      const adapter = adapters[session.gameType];
      if (!adapter) return;

      // "payload" handles things like phase transitions, gameOver, etc.
      adapter.onUnityMsg(session, payload);

      // If adapter marked session.phase = "ended", schedule cleanup
      if (session.phase === "ended") {
        maybeScheduleCleanup(session);
      }

      return;
    }

    // PLAYER -> ADAPTER MESSAGES
    if (msg.type === "playerMsg") {
      const { payload } = msg;
      if (!ws.clientId || !ws.sessionCode) return;

      const session = sessions.get(ws.sessionCode);
      if (!session) return;

      const adapter = adapters[session.gameType];
      if (!adapter) return;

      adapter.onPlayerMsg(session, ws.clientId, payload);
      return;
    }

    // heartbeat from unity? or from player?
    if (msg.type === "ping") {
      safeSend(ws, { type: "pong" });
      return;
    }
  });

  ws.on("close", () => {
    // If Unity disconnects: PAUSE game + give grace period for reconnection
    if (ws.role === "unity" && ws.sessionCode) {
      const session = sessions.get(ws.sessionCode);
      if (!session) return;

      session.unity.ws = null;

      // If game already ended, just clean up
      if (session.phase === "ended") {
        endSession(session);
        return;
      }

      console.log(
        `[session ${session.code}] UNITY disconnected, starting grace timeout`
      );

      // Notify players that Unity is temporarily gone, but DON'T end yet
      broadcastToPlayers(session, {
        type: "paused",
        reason: "unity_disconnected",
      });

      // Give Unity some time to reconnect before ending session
      scheduleUnityTimeout(session);
      return;
    }

    // If player disconnects: make resumable & notify adapter
    if (ws.role === "player" && ws.sessionCode && ws.clientId) {
      const session = sessions.get(ws.sessionCode);
      if (!session) return;
      const adapter = adapters[session.gameType];
      if (!adapter) return;

      const clientId = ws.clientId;
      const player = session.players[clientId];
      if (!player) return;

      // Save resumable identity (latest team wins)
      if (player.resumeToken) {
        session.resumables[player.resumeToken] = {
          username: player.username,
          seat: player.seat || null,
          teamIndex: player.teamIndex,
        };
      }

      // Remove from adapter rosters
      try {
        adapter.onPlayerLeave(session, clientId);
      } catch (_) {}

      // Remove from active players
      delete session.players[clientId];
    }
  });
});

// ping/pong keepalive
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      try {
        ws.terminate();
      } catch (_) {}
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {}
  });
}, 15000);

server.listen(3000, () => {
  console.log("WS server listening on :3000");
});
