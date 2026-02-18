// games/truckofwar.js
// Truck Of War adapter (independent as possible)
//
// FIX (2026-02-18):
// - Rejoiners were being counted as "new players" because meta was keyed by clientId.
// - Now we key meta by stableUid (resumeToken), and keep clientId -> uid mapping.
// - JSON + ranks now reflect UNIQUE players, not connections.
//
// Core:
// - Backend decides team (least-filled; tie -> Team A)
// - Reject duplicate usernames per room (case-insensitive) UNLESS same stableUid
// - Counts taps ONLY when session.phase === "active" (backend authoritative)
// - On match end -> compute ranks + send winner/loser + write JSON to S3
//
// Round UX (NEW):
// - Unity may send:
//    - { kind:"roundEnd", winnerTeamIndex, roundIndex? }
//      -> send each player: { type:"roundEnd", result:"won"|"lost", roundIndex }
//    - { kind:"roundStarting", bufferSeconds:3, roundIndex? }
//      -> broadcast: { type:"roundStarting", bufferSeconds, roundIndex }
//    - { kind:"roundLive", roundIndex? }
//      -> broadcast: { type:"roundLive", roundIndex }

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function broadcastToPlayers(session, obj) {
  const msg = JSON.stringify(obj);
  for (const p of Object.values(session.players || {})) {
    try {
      if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
    } catch (_) {}
  }
}

function broadcastToUnity(session, obj) {
  safeSend(session.unity?.ws, obj);
}

function nowIso() {
  return new Date().toISOString();
}

function compactIsoForFilename(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function normName(name) {
  return String(name || "").trim();
}

function nameKey(name) {
  return normName(name).toLowerCase();
}

function getStableUid(session, clientId) {
  return session.players?.[clientId]?.resumeToken || clientId;
}

/* ===========================
   State helpers
=========================== */

function ensureState(session) {
  if (!session.state || typeof session.state !== "object") session.state = {};
  const st = session.state;

  if (!Array.isArray(st.teams)) st.teams = [[], []];
  if (!Array.isArray(st.teams[0])) st.teams[0] = [];
  if (!Array.isArray(st.teams[1])) st.teams[1] = [];

  // FIX: identity maps
  if (!st.uidByClientId) st.uidByClientId = {};          // clientId -> uid
  if (!st.clientIdByUid) st.clientIdByUid = {};          // uid -> last clientId

  // FIX: meta is now UID-keyed (not clientId-keyed)
  if (!st.playerMetaByUid) st.playerMetaByUid = {};      // uid -> meta

  // nameKey -> uid (stable ownership)
  if (!st.uidByNameKey) st.uidByNameKey = {};

  // nameKey -> final result payload
  if (!st.finalResultsByNameKey) st.finalResultsByNameKey = {};

  // uid -> taps (optional)
  if (!st.tapsByUid) st.tapsByUid = {};

  if (!st.bestOf) st.bestOf = 3;

  if (typeof st.roundIndex !== "number") st.roundIndex = 1;
  if (typeof st.roundsWonA !== "number") st.roundsWonA = 0;
  if (typeof st.roundsWonB !== "number") st.roundsWonB = 0;

  if (typeof st.winningTeamIndex !== "number") st.winningTeamIndex = null;
  if (typeof st.lastRoundWinnerTeamIndex !== "number") st.lastRoundWinnerTeamIndex = null;

  return st;
}

function pickLeastFilledTeamIndex(st) {
  const a = st.teams[0].length;
  const b = st.teams[1].length;
  if (a === 0 && b === 0) return 0;
  if (a < b) return 0;
  if (b < a) return 1;
  return 0;
}

function uniquePlayersCount(st) {
  return Object.keys(st.playerMetaByUid || {}).length;
}

function snapshot(session) {
  const st = ensureState(session);
  return {
    code: session.code,
    gameType: session.gameType,
    phase: session.phase,
    allowedNumberOfPlayers: session.allowedNumberOfPlayers,
    bestOf: st.bestOf,
    roundIndex: st.roundIndex,
    roundsWonA: st.roundsWonA,
    roundsWonB: st.roundsWonB,
    winningTeamIndex: st.winningTeamIndex ?? null,
    playersTotal: uniquePlayersCount(st), // FIX: unique players
    teamAPlayers: st.teams[0].slice(),
    teamBPlayers: st.teams[1].slice(),
  };
}

/* ===========================
   S3 Upload (best-effort)
=========================== */

function getS3BucketName() {
  return (
    process.env.S3_BUCKET_NAME ||
    process.env.CINEMAGAMES_S3_BUCKET ||
    process.env.AWS_S3_BUCKET ||
    process.env.S3_BUCKET ||
    ""
  ).trim();
}

async function uploadJsonToS3({ bucket, key, bodyObj }) {
  if (!bucket) {
    console.warn("[truckofwar] S3 bucket env not set; skipping upload");
    return { ok: false, reason: "missing_bucket" };
  }

  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = require("@aws-sdk/client-s3"));
  } catch (e) {
    console.warn("[truckofwar] @aws-sdk/client-s3 not installed; skipping upload");
    return { ok: false, reason: "missing_sdk" };
  }

  const region =
    (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "").trim() ||
    "ap-southeast-1";

  const client = new S3Client({ region });
  const Body = Buffer.from(JSON.stringify(bodyObj, null, 2), "utf-8");

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body,
        ContentType: "application/json; charset=utf-8",
      })
    );
    return { ok: true };
  } catch (e) {
    console.warn("[truckofwar] S3 upload failed:", e?.message || e);
    return { ok: false, reason: "upload_failed" };
  }
}

/* ===========================
   Ranking + JSON build (FIXED: unique UID meta)
=========================== */

function computeRanks(st, winningTeamIndex) {
  const list = Object.values(st.playerMetaByUid || {}).map((meta) => ({
    uid: meta.uid,
    name: meta.name,
    nameKey: meta.nameKey,
    taps: meta.taps || 0,
    teamIndex: meta.teamIndex,
    joinedAt: meta.joinedAt || meta.firstSeenAt || nowIso(),
  }));

  // Global rank (gtr)
  list.sort((a, b) => {
    if (b.taps !== a.taps) return b.taps - a.taps;
    const ta = Date.parse(a.joinedAt) || 0;
    const tb = Date.parse(b.joinedAt) || 0;
    if (ta !== tb) return ta - tb;
    if (a.nameKey < b.nameKey) return -1;
    if (a.nameKey > b.nameKey) return 1;
    return 0;
  });

  const gtrByNameKey = {};
  for (let i = 0; i < list.length; i++) gtrByNameKey[list[i].nameKey] = i + 1;

  // Team rank (ttr)
  const ttrByNameKey = {};
  for (const teamIndex of [0, 1]) {
    const teamList = list.filter((x) => x.teamIndex === teamIndex);
    teamList.sort((a, b) => {
      if (b.taps !== a.taps) return b.taps - a.taps;
      const ta = Date.parse(a.joinedAt) || 0;
      const tb = Date.parse(b.joinedAt) || 0;
      if (ta !== tb) return ta - tb;
      if (a.nameKey < b.nameKey) return -1;
      if (a.nameKey > b.nameKey) return 1;
      return 0;
    });
    for (let i = 0; i < teamList.length; i++) ttrByNameKey[teamList[i].nameKey] = i + 1;
  }

  const stateByNameKey = {};
  for (const p of list) {
    const isWinner =
      typeof winningTeamIndex === "number" &&
      (winningTeamIndex === 0 || winningTeamIndex === 1) &&
      p.teamIndex === winningTeamIndex;

    stateByNameKey[p.nameKey] = isWinner ? "winner" : "loser";
  }

  return { list, gtrByNameKey, ttrByNameKey, stateByNameKey };
}

function computeTeamTapTotals(st) {
  let teamATaps = 0;
  let teamBTaps = 0;

  for (const meta of Object.values(st.playerMetaByUid || {})) {
    const taps = Math.max(0, Number(meta?.taps || 0) || 0);
    if (meta?.teamIndex === 0) teamATaps += taps;
    else if (meta?.teamIndex === 1) teamBTaps += taps;
  }

  return { teamATaps, teamBTaps };
}

function resolveWinnerTeamIndex(st, explicitWinnerTeamIndex) {
  if (explicitWinnerTeamIndex === 0 || explicitWinnerTeamIndex === 1) {
    return explicitWinnerTeamIndex;
  }

  const { teamATaps, teamBTaps } = computeTeamTapTotals(st);
  if (teamATaps > teamBTaps) return 0;
  if (teamBTaps > teamATaps) return 1;

  const teamAPlayers = Object.values(st.playerMetaByUid || {}).filter(
    (meta) => meta?.teamIndex === 0
  ).length;
  const teamBPlayers = Object.values(st.playerMetaByUid || {}).filter(
    (meta) => meta?.teamIndex === 1
  ).length;

  if (teamAPlayers > teamBPlayers) return 0;
  if (teamBPlayers > teamAPlayers) return 1;

  // Final deterministic fallback (no ties): Team A.
  return 0;
}

function buildS3Json(session) {
  const st = ensureState(session);

  const winningTeamIndex = st.winningTeamIndex;
  const winningTeam =
    winningTeamIndex === 0 ? "Team A" : winningTeamIndex === 1 ? "Team B" : "Unknown";

  const timeStarted = st.timeStarted || "";
  const timeEnded = st.timeEnded || nowIso();

  const { list, gtrByNameKey, ttrByNameKey, stateByNameKey } = computeRanks(st, winningTeamIndex);

  const teamAPlayers = {};
  const teamBPlayers = {};

  for (const p of list) {
    const record = {
      uid: p.uid,
      taps: p.taps,
      team: p.teamIndex === 0 ? "Team A" : "Team B",
      ttr: ttrByNameKey[p.nameKey] ?? null,
      gtr: gtrByNameKey[p.nameKey] ?? null,
      state: stateByNameKey[p.nameKey] || "loser",
    };

    if (p.teamIndex === 0) teamAPlayers[p.name] = record;
    else teamBPlayers[p.name] = record;
  }

  return {
    gameRoomCode: session.code,
    winningTeam,
    timeStarted,
    timeEnded,
    numberOfPlayersJoined: list.length, // FIX: unique meta list
    teamAPlayers,
    teamBPlayers,
  };
}

/* ===========================
   Finalize + broadcast
=========================== */

async function finalizeGameAndRecord(session, { reason, winnerTeamIndex }) {
  const st = ensureState(session);

  if (session.phase === "ended") return;

  st.winningTeamIndex = resolveWinnerTeamIndex(st, winnerTeamIndex);

  if (!st.timeEnded) st.timeEnded = nowIso();
  if (!st.timeStarted) st.timeStarted = st.timeEnded;

  session.phase = "ended";

  const winningTeam =
    st.winningTeamIndex === 0 ? "Team A" : st.winningTeamIndex === 1 ? "Team B" : "Unknown";

  const { gtrByNameKey, ttrByNameKey, stateByNameKey } = computeRanks(st, st.winningTeamIndex);

  // Cache results by nameKey (stable for resume)
  for (const meta of Object.values(st.playerMetaByUid)) {
    st.finalResultsByNameKey[meta.nameKey] = {
      uid: meta.uid,
      taps: meta.taps || 0,
      teamIndex: meta.teamIndex,
      team: meta.teamIndex === 0 ? "Team A" : "Team B",
      winningTeam,
      state: stateByNameKey[meta.nameKey] || "loser",
      ttr: ttrByNameKey[meta.nameKey] ?? null,
      gtr: gtrByNameKey[meta.nameKey] ?? null,
    };
  }

  broadcastToPlayers(session, { type: "phase", phase: "ended", reason: reason || "ended" });

  for (const p of Object.values(session.players || {})) {
    const uname = normName(p.username);
    const nk = nameKey(uname);
    const result = st.finalResultsByNameKey[nk];
    if (!result) continue;

    safeSend(p.ws, {
      type: "gameResult",
      ok: true,
      state: result.state, // "winner" | "loser"
      winningTeam: result.winningTeam,
      team: result.team,
      teamIndex: result.teamIndex,
      taps: result.taps,
      ttr: result.ttr,
      gtr: result.gtr,
      reason: reason || null,
    });
  }

  const jsonObj = buildS3Json(session);
  const bucket = getS3BucketName();
  const dt = compactIsoForFilename(jsonObj.timeEnded || nowIso());
  const key = `games/truckofwar/tow${dt}_${session.code}.json`;

  const res = await uploadJsonToS3({ bucket, key, bodyObj: jsonObj });

  broadcastToUnity(session, {
    type: "recordSaved",
    ok: !!res.ok,
    key,
    bucket: bucket || null,
    reason: res.ok ? null : res.reason || "unknown",
    endedReason: reason || null,
    winningTeam,
  });
}

/* ===========================
   Adapter exports
=========================== */

module.exports = {
  onInit(cfg) {
    const bestOf = Number(cfg.bestOf || cfg.best_of || 3) || 3;
    return {
      bestOf,
      teams: [[], []],

      // FIX
      uidByClientId: {},
      clientIdByUid: {},
      playerMetaByUid: {},

      uidByNameKey: {},
      tapsByUid: {},
      finalResultsByNameKey: {},

      roundIndex: 1,
      roundsWonA: 0,
      roundsWonB: 0,
      winningTeamIndex: null,
      lastRoundWinnerTeamIndex: null,

      timeStarted: "",
      timeEnded: "",
    };
  },

  snapshot,

  onPlayerJoin(session, clientId) {
    const st = ensureState(session);

    const p = session.players?.[clientId];
    if (!p) return;

    const uname = normName(p.username);
    const nk = nameKey(uname);
    const stableUid = getStableUid(session, clientId);

    // Duplicate username guard (allow same UID)
    const existingUid = st.uidByNameKey[nk];
    if (existingUid && existingUid !== stableUid) {
      safeSend(p.ws, {
        type: "joinResult",
        ok: false,
        reason: "duplicate_username",
        message: "That name is already taken. Please choose another.",
      });
      try { p.ws.close(); } catch (_) {}
      return;
    }

    // If this UID already exists, it's a rejoin — keep their team + taps
    let meta = st.playerMetaByUid[stableUid];

    // Assign team:
    // - if existing meta: keep
    // - else: least-filled
    let teamIndex =
      meta && (meta.teamIndex === 0 || meta.teamIndex === 1)
        ? meta.teamIndex
        : pickLeastFilledTeamIndex(st);

    p.teamIndex = teamIndex;

    // Ownership + mappings
    st.uidByNameKey[nk] = stableUid;
    st.uidByClientId[clientId] = stableUid;
    st.clientIdByUid[stableUid] = clientId;

    // Ensure roster shows unique names (remove from other team if present)
    for (const ti of [0, 1]) {
      const idx = st.teams[ti].indexOf(uname);
      if (idx >= 0 && ti !== teamIndex) st.teams[ti].splice(idx, 1);
    }
    if (!st.teams[teamIndex].includes(uname)) st.teams[teamIndex].push(uname);

    // Ensure meta exists
    if (!meta) {
      meta = st.playerMetaByUid[stableUid] = {
        uid: stableUid,
        name: uname,
        nameKey: nk,
        teamIndex,
        taps: 0,
        firstSeenAt: nowIso(),
        joinedAt: nowIso(),
      };
    } else {
      // keep taps + joinedAt, but refresh name/team if needed
      meta.uid = stableUid;
      meta.name = uname;
      meta.nameKey = nk;
      meta.teamIndex = teamIndex;
      if (!meta.joinedAt) meta.joinedAt = nowIso();
    }

    if (typeof st.tapsByUid[stableUid] !== "number") st.tapsByUid[stableUid] = meta.taps || 0;

    // Tell Unity
    broadcastToUnity(session, {
      type: "playerJoined",
      uid: stableUid,
      username: uname,
      teamIndex,
      team: teamIndex === 0 ? "Team A" : "Team B",
      snapshot: snapshot(session),
    });

    // Ack player
    safeSend(p.ws, {
      type: "joined",
      ok: true,
      code: session.code,
      uid: stableUid,
      username: uname,
      teamIndex,
      team: teamIndex === 0 ? "Team A" : "Team B",
      phase: session.phase,
      snapshot: snapshot(session),
    });

    // If already ended, immediately send results
    if (session.phase === "ended") {
      const result = st.finalResultsByNameKey[nk];
      if (result) {
        safeSend(p.ws, {
          type: "gameResult",
          ok: true,
          state: result.state,
          winningTeam: result.winningTeam,
          team: result.team,
          teamIndex: result.teamIndex,
          taps: result.taps,
          ttr: result.ttr,
          gtr: result.gtr,
          reason: "already_ended",
        });
      }
    }
  },

  onPlayerResume(session, clientId, entry) {
    const st = ensureState(session);
    const p = session.players?.[clientId];
    if (!p) return;

    const uname = normName(entry?.username || p.username);
    const nk = nameKey(uname);
    const stableUid = getStableUid(session, clientId);

    // Duplicate username guard (allow same UID)
    const existingUid = st.uidByNameKey[nk];
    if (existingUid && existingUid !== stableUid) {
      safeSend(p.ws, {
        type: "resumeResult",
        ok: false,
        reason: "duplicate_username",
        message: "That name is already taken. Please choose another.",
      });
      try { p.ws.close(); } catch (_) {}
      return;
    }

    // If UID exists, treat as reattach
    let meta = st.playerMetaByUid[stableUid];

    // Choose team:
    // - if entry explicitly says teamIndex: honor it
    // - else if meta exists: keep
    // - else least-filled
    let teamIndex =
      entry?.teamIndex === 0 || entry?.teamIndex === 1
        ? entry.teamIndex
        : meta && (meta.teamIndex === 0 || meta.teamIndex === 1)
          ? meta.teamIndex
          : pickLeastFilledTeamIndex(st);

    p.username = uname;
    p.teamIndex = teamIndex;

    st.uidByNameKey[nk] = stableUid;
    st.uidByClientId[clientId] = stableUid;
    st.clientIdByUid[stableUid] = clientId;

    // Ensure roster
    for (const ti of [0, 1]) {
      const idx = st.teams[ti].indexOf(uname);
      if (idx >= 0 && ti !== teamIndex) st.teams[ti].splice(idx, 1);
    }
    if (!st.teams[teamIndex].includes(uname)) st.teams[teamIndex].push(uname);

    // Ensure meta
    if (!meta) {
      meta = st.playerMetaByUid[stableUid] = {
        uid: stableUid,
        name: uname,
        nameKey: nk,
        teamIndex,
        taps: 0,
        firstSeenAt: nowIso(),
        joinedAt: nowIso(),
      };
    } else {
      meta.uid = stableUid;
      meta.name = uname;
      meta.nameKey = nk;
      meta.teamIndex = teamIndex;
      if (!meta.joinedAt) meta.joinedAt = nowIso();
    }

    if (typeof st.tapsByUid[stableUid] !== "number") st.tapsByUid[stableUid] = meta.taps || 0;

    // Inform Unity
    broadcastToUnity(session, {
      type: "playerResumed",
      uid: stableUid,
      username: uname,
      teamIndex,
      team: teamIndex === 0 ? "Team A" : "Team B",
      snapshot: snapshot(session),
    });

    // Ack resume
    safeSend(p.ws, {
      type: "resumed",
      ok: true,
      code: session.code,
      uid: stableUid,
      username: uname,
      teamIndex,
      team: teamIndex === 0 ? "Team A" : "Team B",
      phase: session.phase,
      snapshot: snapshot(session),
    });

    // If ended, immediately send result
    if (session.phase === "ended") {
      const result = st.finalResultsByNameKey[nk];
      if (result) {
        safeSend(p.ws, {
          type: "gameResult",
          ok: true,
          state: result.state,
          winningTeam: result.winningTeam,
          team: result.team,
          teamIndex: result.teamIndex,
          taps: result.taps,
          ttr: result.ttr,
          gtr: result.gtr,
          reason: "resume_after_end",
        });
      } else {
        safeSend(p.ws, { type: "phase", phase: "ended" });
      }
    }
  },

  onPlayerLeave(session, clientId) {
    const st = ensureState(session);
    const p = session.players?.[clientId];

    const stableUid = st.uidByClientId?.[clientId] || getStableUid(session, clientId);
    const meta = st.playerMetaByUid?.[stableUid];

    const uname = normName(p?.username || meta?.name);
    const teamIndex = p?.teamIndex ?? meta?.teamIndex;

    // Remove from roster list (visual roster only; meta stays)
    if (uname && (teamIndex === 0 || teamIndex === 1)) {
      const roster = st.teams[teamIndex];
      const idx = roster.indexOf(uname);
      if (idx >= 0) roster.splice(idx, 1);
    }

    // Keep meta + ownership for resume, do NOT delete meta
    broadcastToUnity(session, {
      type: "playerLeft",
      uid: stableUid || null,
      username: uname || "",
      snapshot: snapshot(session),
    });
  },

  onPlayerMsg(session, clientId, payload) {
    const st = ensureState(session);
    const p = session.players?.[clientId];
    if (!p) return;

    if (session.phase !== "active") return;

    if (!payload || typeof payload !== "object") return;
    const kind = String(payload.kind || payload.type || "").toLowerCase();
    if (kind !== "tap" && kind !== "pull" && kind !== "click") return;

    const stableUid = st.uidByClientId?.[clientId] || getStableUid(session, clientId);
    const meta = st.playerMetaByUid?.[stableUid];
    if (!meta) return;

    const inc = Math.max(1, Number(payload.amount || payload.count || 1) || 1);

    meta.taps = (meta.taps || 0) + inc;
    st.tapsByUid[stableUid] = meta.taps;

    broadcastToUnity(session, {
      type: "tap",
      uid: meta.uid,
      username: meta.name,
      teamIndex: meta.teamIndex,
      count: inc,
      taps: meta.taps,
    });
  },

  onUnityMsg(session, payload) {
    const st = ensureState(session);
    if (!payload || typeof payload !== "object") return;

    // ROUND SIGNALS
    if (payload.kind === "roundEnd") {
      const winnerTeamIndex =
        payload.winnerTeamIndex === 0 || payload.winnerTeamIndex === 1
          ? payload.winnerTeamIndex
          : null;

      const roundIndex = typeof payload.roundIndex === "number" ? payload.roundIndex : st.roundIndex;

      st.lastRoundWinnerTeamIndex = winnerTeamIndex;
      if (winnerTeamIndex === 0) st.roundsWonA += 1;
      if (winnerTeamIndex === 1) st.roundsWonB += 1;

      for (const p of Object.values(session.players || {})) {
        if (!p || !p.ws) continue;
        const myTeam = p.teamIndex;
        const result =
          winnerTeamIndex === null ? "lost" : myTeam === winnerTeamIndex ? "won" : "lost";

        safeSend(p.ws, {
          type: "roundEnd",
          ok: true,
          roundIndex,
          result,
          winnerTeamIndex,
        });
      }
      return;
    }

    if (payload.kind === "roundStarting") {
      const bufferSeconds = Math.max(0, Number(payload.bufferSeconds ?? 3) || 3);
      const roundIndex =
        typeof payload.roundIndex === "number" ? payload.roundIndex : st.roundIndex + 1;

      st.roundIndex = roundIndex;

      broadcastToPlayers(session, {
        type: "roundStarting",
        ok: true,
        roundIndex,
        bufferSeconds,
      });
      return;
    }

    if (payload.kind === "roundLive") {
      const roundIndex = typeof payload.roundIndex === "number" ? payload.roundIndex : st.roundIndex;
      broadcastToPlayers(session, { type: "roundLive", ok: true, roundIndex });
      return;
    }

    // PHASE
    if (payload.kind === "phase") {
      const phase = payload.phase;

      if (phase === "active") {
        session.phase = "active";
        if (!st.timeStarted) st.timeStarted = nowIso();
        broadcastToPlayers(session, { type: "phase", phase: "active" });
      } else if (phase === "join") {
        session.phase = "join";
        broadcastToPlayers(session, { type: "phase", phase: "join" });
      } else if (phase === "ended") {
        finalizeGameAndRecord(session, { reason: "unity_phase_ended", winnerTeamIndex: null }).catch(() => {});
      }
      return;
    }

    // SNAPSHOT
    if (payload.kind === "requestSnapshot") {
      safeSend(session.unity?.ws, { type: "state", snapshot: snapshot(session) });
      return;
    }

    // GAME OVER
    if (payload.kind === "gameOver") {
      finalizeGameAndRecord(session, {
        reason: "unity_gameOver",
        winnerTeamIndex: payload.winnerTeamIndex,
      }).catch(() => {});
      return;
    }
  },

  async onForcedEnd(session, info) {
    const reason = info?.reason || "forced_end";
    await finalizeGameAndRecord(session, { reason, winnerTeamIndex: null });
  },

  async onSessionEnd(session, info) {
    if (session.phase === "ended") return;
    const reason = info?.reason || "session_end";
    await finalizeGameAndRecord(session, { reason, winnerTeamIndex: null });
  },
};
