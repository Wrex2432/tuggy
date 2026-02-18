// GameLogic.cs
// Truck Of War — Game brain (rules + rope/marker + best-of + win condition)
//
// Responsibilities:
// - Owns match state (Lobby/Buffer/Active/RoundIntermission/Ended)
// - Receives tap events (from BackendConnector via Initializer or direct wiring)
// - Converts taps -> team pull -> moves rope marker
// - Detects goal hit -> round winner -> best-of logic
// - On match end -> tells backend via BackendConnector: unityMsg { kind:"gameOver", winnerTeamIndex }
//
// Notes:
// - Backend is authoritative for counting taps + final win/lose pages.
// - Unity can still ignore taps during buffer/intermission even if backend forwards them.
// - Initializer handles initial lobby timer + initial buffer before first round.
//   GameLogic handles ONLY gameplay + between-round reset buffer.
//
// Scene requirements (bare bones):
// - markerTransform: Transform of rope midpoint marker (moves along X between goals)
// - goalLeftTransform: Transform for Team A goal (left)
// - goalRightTransform: Transform for Team B goal (right)
// - Optional UI Texts
//
// Team mapping:
// - teamIndex 0 = Team A (left)
// - teamIndex 1 = Team B (right)

using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

public class GameLogic : MonoBehaviour
{
    public enum Phase
    {
        None,
        Lobby,
        Buffer,
        RoundActive,
        RoundIntermission,
        Ended
    }

    [Serializable]
    public class ControlConfig
    {
        public string gameType = "truckofwar";
        public string location = "CINEMA_A";
        public int allowedNumberOfPlayers = 20;

        public int roomCodeLength = 4;

        public int lobbyDurationSeconds = 20;
        public string allowManualStartKey = "n";

        public int bufferCountdownSeconds = 3;

        public int totalRounds = 3; // best-of (odd recommended)

        public float tapStrengthMultiplier = 1.0f;

        public bool allowLateJoin = true;

        public bool recordGameData = true;

        public string backendWsUrl = "wss://api.prologuebymetama.com/ws";
    }

    [Header("References")]
    [SerializeField] private BackendConnector backend;

    [Header("Rope / Marker")]
    [SerializeField] private Transform markerTransform;
    [SerializeField] private Transform goalLeftTransform;   // Team A goal (left)
    [SerializeField] private Transform goalRightTransform;  // Team B goal (right)

    [Header("Tuning (feel)")]
    [Tooltip("How much one tap contributes to pull impulse. Final is impulse * tapStrengthMultiplier.")]
    [SerializeField] private float impulsePerTap = 1.0f;

    [Tooltip("How fast marker responds to accumulated pull each FixedUpdate.")]
    [SerializeField] private float pullToVelocity = 0.015f;

    [Tooltip("Damping applied to marker velocity each FixedUpdate. Closer to 1 = less damping.")]
    [Range(0.0f, 1.0f)]
    [SerializeField] private float velocityDamping = 0.90f;

    [Tooltip("Clamp marker velocity magnitude.")]
    [SerializeField] private float maxVelocity = 3.0f;

    [Header("Between Rounds")]
    [Tooltip("Seconds to wait between rounds (visual reset buffer). Uses control.json bufferCountdownSeconds if > 0.")]
    [SerializeField] private int betweenRoundBufferSecondsOverride = -1;

    [Header("Optional UI")]
    [SerializeField] private Text phaseText;
    [SerializeField] private Text roundText;
    [SerializeField] private Text scoreText;
    [SerializeField] private Text debugText;

    // Runtime
    private ControlConfig _cfg;
    private string _roomCode = "";

    private Phase _phase = Phase.None;

    private int _roundIndex = 1;
    private int _winsA = 0;
    private int _winsB = 0;

    private float _bufferEndsAt = 0f;

    // marker motion
    private float _startX = 0f;
    private float _markerX = 0f;
    private float _markerV = 0f;

    // tap accumulation (per fixed step)
    private int _pendingTapsA = 0;
    private int _pendingTapsB = 0;

    // optional per-player tap tracking for visuals/debug
    private readonly Dictionary<string, int> _playerTaps = new Dictionary<string, int>(); // uid -> taps
    private readonly Dictionary<string, int> _playerTeam = new Dictionary<string, int>(); // uid -> teamIndex

    private void Awake()
    {
        if (markerTransform != null) _startX = markerTransform.position.x;
        _markerX = _startX;
    }

    private void Start()
    {
        SetPhase(Phase.None);
        UpdateUI();
    }

    /* ============================
       Called by Initializer
    ============================ */

    public void ApplyConfig(Initializer.ControlConfig cfgFromInitializer)
    {
        // Convert Initializer.ControlConfig -> GameLogic.ControlConfig
        // (keeps scripts decoupled even if you later move ControlConfig into its own file)
        _cfg = new ControlConfig
        {
            gameType = cfgFromInitializer.gameType,
            location = cfgFromInitializer.location,
            allowedNumberOfPlayers = cfgFromInitializer.allowedNumberOfPlayers,
            roomCodeLength = cfgFromInitializer.roomCodeLength,
            lobbyDurationSeconds = cfgFromInitializer.lobbyDurationSeconds,
            allowManualStartKey = cfgFromInitializer.allowManualStartKey,
            bufferCountdownSeconds = cfgFromInitializer.bufferCountdownSeconds,
            totalRounds = cfgFromInitializer.totalRounds,
            tapStrengthMultiplier = cfgFromInitializer.tapStrengthMultiplier,
            allowLateJoin = cfgFromInitializer.allowLateJoin,
            recordGameData = cfgFromInitializer.recordGameData,
            backendWsUrl = cfgFromInitializer.backendWsUrl
        };
    }

    public void SetPhaseLobby(string roomCode)
    {
        _roomCode = roomCode ?? "";
        ResetMatchState();
        SetPhase(Phase.Lobby);
    }

    public void SetPhaseBuffer(int seconds)
    {
        // This is the *pre-game* buffer controlled by Initializer
        SetPhase(Phase.Buffer);
        _bufferEndsAt = Time.time + Mathf.Max(0, seconds);
        UpdateUI();
    }

    public void StartGame(string roomCode)
    {
        _roomCode = roomCode ?? _roomCode;
        // Start Round 1
        BeginRoundActive();
    }

    /* ============================
       From Initializer when players join (optional)
    ============================ */

    public void OnPlayerJoined(string uid, string username, int teamIndex)
    {
        if (string.IsNullOrEmpty(uid)) return;

        if (!_playerTaps.ContainsKey(uid)) _playerTaps[uid] = 0;
        _playerTeam[uid] = teamIndex;

        // No gameplay logic needed here; spawner handles visuals.
        UpdateDebugRosterLine();
    }

    /* ============================
       Helper for round Checks
    ============================ */

    private void SendRoundEnd(int winnerTeamIndex, int roundIndex)
    {
        if (backend == null) return;

        var payload = new Dictionary<string, object>
    {
        { "kind", "roundEnd" },
        { "winnerTeamIndex", winnerTeamIndex },
        { "roundIndex", roundIndex }
    };

        backend.SendUnityMsg(_roomCode, payload);
    }

    private void SendRoundStarting(int bufferSeconds, int roundIndex)
    {
        if (backend == null) return;

        var payload = new Dictionary<string, object>
    {
        { "kind", "roundStarting" },
        { "bufferSeconds", bufferSeconds },
        { "roundIndex", roundIndex }
    };

        backend.SendUnityMsg(_roomCode, payload);
    }

    private void SendRoundLive(int roundIndex)
    {
        if (backend == null) return;

        var payload = new Dictionary<string, object>
    {
        { "kind", "roundLive" },
        { "roundIndex", roundIndex }
    };

        backend.SendUnityMsg(_roomCode, payload);
    }



    /* ============================
       From BackendConnector tap events
    ============================ */

    public void OnTap(string uid, string username, int teamIndex, int count, int totalTapsFromBackend)
    {
        // Ignore taps unless a round is actively running
        if (_phase != Phase.RoundActive) return;

        int c = Mathf.Max(1, count);

        if (teamIndex == 0) _pendingTapsA += c;
        else if (teamIndex == 1) _pendingTapsB += c;

        // Optional: track for debug
        if (!string.IsNullOrEmpty(uid))
        {
            _playerTeam[uid] = teamIndex;
            if (!_playerTaps.ContainsKey(uid)) _playerTaps[uid] = 0;
            _playerTaps[uid] = Mathf.Max(_playerTaps[uid], totalTapsFromBackend);
        }
    }

    /* ============================
       Unity loops
    ============================ */

    private void Update()
    {
        if (_phase == Phase.Buffer)
        {
            if (Time.time >= _bufferEndsAt)
            {
                // Buffer ended, but Initializer calls StartGame() already for first round.
                // For between rounds, we use RoundIntermission with its own buffer.
            }
            UpdateUI();
        }

        if (_phase == Phase.RoundIntermission)
        {
            if (Time.time >= _bufferEndsAt)
            {
                BeginRoundActive();
            }
            UpdateUI();
        }
    }

    private void FixedUpdate()
    {
        if (_phase != Phase.RoundActive) return;

        // Convert pending taps into net impulse
        float mult = (_cfg != null) ? _cfg.tapStrengthMultiplier : 1.0f;

        float impulseA = _pendingTapsA * impulsePerTap * mult;
        float impulseB = _pendingTapsB * impulsePerTap * mult;

        // Clear accumulators for next step
        _pendingTapsA = 0;
        _pendingTapsB = 0;

        // Net: A pulls marker LEFT (negative X), B pulls marker RIGHT (positive X)
        float net = impulseB - impulseA;

        // Apply to velocity
        _markerV += net * pullToVelocity;

        // Clamp velocity
        _markerV = Mathf.Clamp(_markerV, -maxVelocity, maxVelocity);

        // Integrate
        _markerX += _markerV * Time.fixedDeltaTime;

        // Damping
        _markerV *= velocityDamping;

        // Clamp within goal bounds (so it doesn't fly past wildly)
        float leftX = goalLeftTransform ? goalLeftTransform.position.x : _startX - 5f;
        float rightX = goalRightTransform ? goalRightTransform.position.x : _startX + 5f;

        _markerX = Mathf.Clamp(_markerX, Mathf.Min(leftX, rightX), Mathf.Max(leftX, rightX));

        // Apply to transform
        if (markerTransform)
        {
            Vector3 p = markerTransform.position;
            p.x = _markerX;
            markerTransform.position = p;
        }

        // Check win condition
        CheckGoalHit(leftX, rightX);
    }

    /* ============================
       Match / Round logic
    ============================ */

    private void ResetMatchState()
    {
        _roundIndex = 1;
        _winsA = 0;
        _winsB = 0;

        _pendingTapsA = 0;
        _pendingTapsB = 0;

        ResetMarkerToCenter();

        _playerTaps.Clear();
        _playerTeam.Clear();

        UpdateUI();
    }

    private void ResetMarkerToCenter()
    {
        if (!markerTransform) return;

        float leftX = goalLeftTransform ? goalLeftTransform.position.x : markerTransform.position.x - 5f;
        float rightX = goalRightTransform ? goalRightTransform.position.x : markerTransform.position.x + 5f;

        float center = (leftX + rightX) * 0.5f;

        _markerX = center;
        _markerV = 0f;

        Vector3 p = markerTransform.position;
        p.x = center;
        markerTransform.position = p;
    }

    private void BeginRoundActive()
    {
        if (_phase == Phase.Ended) return;

        // If match already decided, end
        if (IsMatchOver())
        {
            EndMatch();
            return;
        }

        ResetMarkerToCenter();

        _pendingTapsA = 0;
        _pendingTapsB = 0;

        SetPhase(Phase.RoundActive);
        // NEW: tell web apps the round is now live (enable taps after buffer)
        SendRoundLive(_roundIndex);
        UpdateUI();
    }

    private void CheckGoalHit(float leftX, float rightX)
    {
        // Determine which side reached.
        // Team A wins the round if marker reaches LEFT goal.
        // Team B wins the round if marker reaches RIGHT goal.
        if (!goalLeftTransform || !goalRightTransform)
        {
            // If goals not set, do nothing.
            return;
        }

        // Depending on which goal is actually left/right, handle robustly.
        float minX = Mathf.Min(leftX, rightX);
        float maxX = Mathf.Max(leftX, rightX);

        bool hitLeft = _markerX <= minX + 0.0001f;
        bool hitRight = _markerX >= maxX - 0.0001f;

        if (!hitLeft && !hitRight) return;

        if (hitLeft)
        {
            // Marker hit the left-most goal => Team A wins
            OnRoundWin(0);
            return;
        }

        if (hitRight)
        {
            // Marker hit the right-most goal => Team B wins
            OnRoundWin(1);
            return;
        }
    }

    private void OnRoundWin(int winnerTeamIndex)
    {
        if (_phase != Phase.RoundActive) return;

        if (winnerTeamIndex == 0) _winsA++;
        else _winsB++;

        // NEW: round ended, notify backend so each player sees WON/LOST popup
        SendRoundEnd(winnerTeamIndex, _roundIndex);

        // Advance round
        _roundIndex++;

        // Intermission or end
        if (IsMatchOver())
        {
            EndMatch();
            return;
        }

        // Between-round buffer (visual reset)
        int between = betweenRoundBufferSecondsOverride >= 0
            ? betweenRoundBufferSecondsOverride
            : ((_cfg != null) ? _cfg.bufferCountdownSeconds : 3);

        // NEW: tell web apps a new round is starting, with buffer countdown
        SendRoundStarting(between, _roundIndex);

        SetPhase(Phase.RoundIntermission);
        _bufferEndsAt = Time.time + Mathf.Max(0, between);

        UpdateUI();
    }

    private bool IsMatchOver()
    {
        int bestOf = (_cfg != null) ? Mathf.Max(1, _cfg.totalRounds) : 3;

        // Best-of should usually be odd. Required wins:
        int needed = (bestOf / 2) + 1;

        return _winsA >= needed || _winsB >= needed;
    }

    private int GetMatchWinnerTeamIndex()
    {
        if (_winsA == _winsB) return -1;
        return (_winsA > _winsB) ? 0 : 1;
    }

    private void EndMatch()
    {
        if (_phase == Phase.Ended) return;

        SetPhase(Phase.Ended);
        UpdateUI();

        int winner = GetMatchWinnerTeamIndex();

        // Tell backend the match is over (backend will compute winners/losers + record S3)
        if (backend != null)
        {
            backend.SendUnityGameOver(_roomCode, winner < 0 ? 0 : winner); // fallback to Team A if tie (shouldn't happen in best-of odd)
            backend.SendUnityPhase(_roomCode, "ended");
        }

        // Optional: add any Unity-side visuals here (confetti, UI panels, etc.)
    }

    /* ============================
       UI
    ============================ */

    private void SetPhase(Phase p)
    {
        _phase = p;
    }

    private void UpdateUI()
    {
        if (phaseText) phaseText.text = $"PHASE: {_phase}";

        if (roundText)
        {
            int bestOf = (_cfg != null) ? Mathf.Max(1, _cfg.totalRounds) : 3;
            // roundIndex is 1-based, but we increment after win; clamp display
            int displayRound = Mathf.Clamp(_roundIndex, 1, bestOf);
            roundText.text = $"ROUND: {displayRound}/{bestOf}";
        }

        if (scoreText) scoreText.text = $"TEAM A: {_winsA}  |  TEAM B: {_winsB}";

        UpdateDebugRosterLine();
    }

    private void UpdateDebugRosterLine()
    {
        if (!debugText) return;

        // Keep it short; just show totals + marker position
        int totalPlayers = _playerTeam.Count;
        int a = 0, b = 0;
        foreach (var kv in _playerTeam)
        {
            if (kv.Value == 0) a++;
            else if (kv.Value == 1) b++;
        }

        debugText.text =
            $"Players: {totalPlayers} (A:{a}, B:{b})\n" +
            $"MarkerX: {(_markerTransformSafeX()):0.00}  Vel: {_markerV:0.00}\n" +
            $"Pending taps (this step): A:{_pendingTapsA} B:{_pendingTapsB}";
    }

    private float _markerTransformSafeX()
    {
        if (markerTransform) return markerTransform.position.x;
        return _markerX;
    }
}
