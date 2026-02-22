// Initializer.cs
// Truck Of War (non-headless, bare-bones) — Session bootstrapper
//
// Responsibilities:
// - Load + validate control.json (NO control.json = NO game)
// - Generate room code (length from control.json; default 4)
// - Connect to backend (EC2 WebSocket)
// - Send unityCreate { gameType:"truckofwar", location, allowedNumberOfPlayers, requestedCode }
// - Enter Lobby state (auto-start timer OR press "N")
// - Run Buffer countdown then tell GameLogic to start
//
// NOTE (NEW):
// - For Round 1 we ALSO notify the web app via backend:
//     unityMsg { kind:"roundStarting", bufferSeconds, roundIndex:1 }
//   GameLogic will send roundLive when RoundActive begins.

#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

public class Initializer : MonoBehaviour
{
    public enum BootState
    {
        None,
        LoadingControl,
        ConnectingBackend,
        CreatingSession,
        Lobby,
        BufferCountdown,
        InGame,
        Ended,
        Error
    }

    [Serializable]
    public class ControlConfig
    {
        public string gameType = "truckofwar";
        public string location = "CINEMA_A";
        public int allowedNumberOfPlayers = 20;

        // NEW/CONFIRMED: code length control (default 4)
        public int roomCodeLength = 4;

        public int lobbyDurationSeconds = 60;
        public string allowManualStartKey = "n";

        public int totalRounds = 3;

        public float tapStrengthMultiplier = 1.0f;

        public bool allowLateJoin = true;

        public bool recordGameData = true;

        // Optional: backend URL can live here too
        public string backendWsUrl = "wss://api.prologuebymetama.com/ws";
    }

    [Header("Core References")]
    [SerializeField] private BackendConnector backend;
    [SerializeField] private GameLogic gameLogic;
    [SerializeField] private PlayerSpawner playerSpawner;

    [Header("Optional UI")]
    [SerializeField] private Text stateText;
    [SerializeField] private Text codeText;
    [SerializeField] private Text hintText;

    [Header("Optional Start UI")]
    [SerializeField] private Button startGameButton;

    [Header("Optional Buffer Countdown (TMP)")]
    [SerializeField] private TMP_Text countdownText;
    [SerializeField] private bool showGoMessage = true;
    [SerializeField] private float goMessageDuration = 0.5f;

    [Header("Control.json")]
    [Tooltip("Filename only. Will search Project Root first, then StreamingAssets, then Assets (Editor fallback).")]
    [SerializeField] private string controlJsonFileName = "control.json";

    private BootState _state = BootState.None;
    private ControlConfig _cfg;
    private string _roomCode = "";
    private float _lobbyEndsAt = 0f;
    private float _bufferEndsAt = 0f;
    private float _bufferGoEndsAt = 0f;
    private bool _bufferShowingGo = false;
    private bool _manualStartRequested = false;

    private void Awake()
    {
        SetState(BootState.LoadingControl);
    }

    private void OnEnable()
    {
        if (backend != null)
        {
            backend.OnConnected += HandleBackendConnected;
            backend.OnDisconnected += HandleBackendDisconnected;
            backend.OnUnityCreated += HandleUnityCreated;
            backend.OnUnityError += HandleUnityError;

            // TruckOfWar-specific backend events
            backend.OnTowPlayerJoined += HandleTowPlayerJoined;
            backend.OnTowPlayerResumed += HandleTowPlayerResumed;
            backend.OnTowPlayerLeft += HandleTowPlayerLeft;
            backend.OnTowTap += HandleTowTap;
            backend.OnTowRecordSaved += HandleTowRecordSaved;
            backend.OnTowPaused += HandleTowPaused;
            backend.OnTowEnded += HandleTowEnded;
            backend.OnTowPhase += HandleTowPhase;
        }
    }

    private void OnDisable()
    {
        if (backend != null)
        {
            backend.OnConnected -= HandleBackendConnected;
            backend.OnDisconnected -= HandleBackendDisconnected;
            backend.OnUnityCreated -= HandleUnityCreated;
            backend.OnUnityError -= HandleUnityError;

            backend.OnTowPlayerJoined -= HandleTowPlayerJoined;
            backend.OnTowPlayerResumed -= HandleTowPlayerResumed;
            backend.OnTowPlayerLeft -= HandleTowPlayerLeft;
            backend.OnTowTap -= HandleTowTap;
            backend.OnTowRecordSaved -= HandleTowRecordSaved;
            backend.OnTowPaused -= HandleTowPaused;
            backend.OnTowEnded -= HandleTowEnded;
            backend.OnTowPhase -= HandleTowPhase; // FIX: removed duplicate unhook
        }
    }

    private void Start()
    {
        // Auto-find on same GameObject if missing
        if (backend == null) backend = GetComponent<BackendConnector>();
        if (gameLogic == null) gameLogic = GetComponent<GameLogic>();
        if (playerSpawner == null) playerSpawner = GetComponent<PlayerSpawner>();

        TryLoadControlJsonOrFail();
        if (_state == BootState.Error) return;

        // Generate a code now (backend will accept requestedCode)
        _roomCode = GenerateRoomCode(_cfg.roomCodeLength);

        // Push config into systems
        if (gameLogic != null) gameLogic.ApplyConfig(_cfg);
        if (playerSpawner != null) playerSpawner.ApplyConfig(_cfg);

        // Connect backend
        SetState(BootState.ConnectingBackend);
        if (backend == null)
        {
            Fail("Missing reference: BackendConnector");
            return;
        }

        HideExternalCountdown();
        SyncStartButtonState();
        if (startGameButton != null)
        {
            startGameButton.onClick.RemoveListener(OnStartButtonClicked);
            startGameButton.onClick.AddListener(OnStartButtonClicked);
        }

        // Let backend read URL from cfg by default
        backend.SetServerUrl(_cfg.backendWsUrl);
        backend.Connect();
    }

    private void OnDestroy()
    {
        if (startGameButton != null)
            startGameButton.onClick.RemoveListener(OnStartButtonClicked);
    }

    public void OnStartButtonClicked()
    {
        if (_state != BootState.Lobby) return;

        _manualStartRequested = true;
        BeginBufferCountdown();
        SyncStartButtonState();
    }

    private void Update()
    {
        if (_state == BootState.Error) return;

        // Manual start key (default "n")
        if (_state == BootState.Lobby)
        {
            if (IsManualStartPressed(_cfg.allowManualStartKey))
            {
                _manualStartRequested = true;
            }

            if (_manualStartRequested)
            {
                BeginBufferCountdown();
                return;
            }

            if (Time.time >= _lobbyEndsAt)
            {
                BeginBufferCountdown();
                return;
            }

            UpdateLobbyUI();
        }

        if (_state == BootState.BufferCountdown)
        {
            float remaining = Mathf.Max(0f, _bufferEndsAt - Time.time);
            UpdateStatus(
                $"BUFFER ({Mathf.CeilToInt(remaining)}s)",
                $"ROOM: {_roomCode}",
                "Get ready…"
            );

            if (!_bufferShowingGo)
            {
                ShowExternalCountdown(Mathf.CeilToInt(remaining).ToString());
            }

            if (Time.time >= _bufferEndsAt)
            {
                if (showGoMessage)
                {
                    if (!_bufferShowingGo)
                    {
                        _bufferShowingGo = true;
                        _bufferGoEndsAt = Time.time + Mathf.Max(0f, goMessageDuration);
                        ShowExternalCountdown("GO!");
                    }

                    if (Time.time >= _bufferGoEndsAt)
                    {
                        BeginGame();
                    }
                }
                else
                {
                    BeginGame();
                }
            }
        }
    }

    /* ============================
       Control.json load
    ============================ */

    private void TryLoadControlJsonOrFail()
    {
        SetState(BootState.LoadingControl);

        string json = TryReadControlJson(out string usedPath);
        if (string.IsNullOrEmpty(json))
        {
            Fail(
                "control.json not found.\n\n" +
                "Required path (PROJECT ROOT):\n" +
                $"- {Path.Combine(Directory.GetParent(Application.dataPath).FullName, controlJsonFileName)}\n\n" +
                "Optional fallback paths:\n" +
                $"- {Path.Combine(Application.streamingAssetsPath, controlJsonFileName)}\n" +
                $"- {Path.Combine(Application.dataPath, controlJsonFileName)}\n\n" +
                "No control.json = No game."
            );
            return;
        }

        try
        {
            _cfg = JsonConvert.DeserializeObject<ControlConfig>(json);
        }
        catch (Exception e)
        {
            Fail($"control.json parse error at:\n{usedPath}\n\n{e.Message}");
            return;
        }

        if (_cfg == null)
        {
            Fail($"control.json invalid (null) at:\n{usedPath}");
            return;
        }

        // Validate required keys
        if (string.IsNullOrWhiteSpace(_cfg.gameType))
        {
            Fail("control.json missing required key: gameType");
            return;
        }

        if (!_cfg.gameType.Trim().Equals("truckofwar", StringComparison.OrdinalIgnoreCase))
        {
            Fail($"control.json gameType must be 'truckofwar' (got '{_cfg.gameType}')");
            return;
        }

        if (_cfg.allowedNumberOfPlayers <= 0)
        {
            Fail("control.json allowedNumberOfPlayers must be > 0");
            return;
        }

        // IMPORTANT: code length control (default 4)
        if (_cfg.roomCodeLength <= 0) _cfg.roomCodeLength = 4;
        if (_cfg.roomCodeLength < 3 || _cfg.roomCodeLength > 8)
        {
            Fail("control.json roomCodeLength must be between 3 and 8");
            return;
        }

        // Default to 60s lobby if value is missing/invalid to avoid accidental instant starts.
        if (_cfg.lobbyDurationSeconds <= 0) _cfg.lobbyDurationSeconds = 60;

        UpdateStatus(
            "CONTROL LOADED",
            "Path OK",
            $"Type={_cfg.gameType} Players={_cfg.allowedNumberOfPlayers} CodeLen={_cfg.roomCodeLength}"
        );
    }

    private string TryReadControlJson(out string usedPath)
    {
        usedPath = "";

        // 1) PROJECT ROOT (required by your rule): <project>/control.json
        try
        {
            string projectRoot = Directory.GetParent(Application.dataPath).FullName;
            string p0 = Path.Combine(projectRoot, controlJsonFileName);
            if (File.Exists(p0))
            {
                usedPath = p0;
                return File.ReadAllText(p0, Encoding.UTF8);
            }
        }
        catch { }

        // 2) Optional fallback: StreamingAssets/control.json
        try
        {
            string p1 = Path.Combine(Application.streamingAssetsPath, controlJsonFileName);
            if (File.Exists(p1))
            {
                usedPath = p1;
                return File.ReadAllText(p1, Encoding.UTF8);
            }
        }
        catch { }

        // 3) Optional editor fallback: Assets/control.json
        try
        {
            string p2 = Path.Combine(Application.dataPath, controlJsonFileName);
            if (File.Exists(p2))
            {
                usedPath = p2;
                return File.ReadAllText(p2, Encoding.UTF8);
            }
        }
        catch { }

        return null;
    }

    /* ============================
       Backend flow
    ============================ */

    private void HandleBackendConnected()
    {
        if (_state != BootState.ConnectingBackend) return;

        SetState(BootState.CreatingSession);

        backend.SendUnityCreate(new BackendConnector.UnityCreateMsg
        {
            gameType = "truckofwar",
            location = _cfg.location,
            teamCount = 2,
            allowedNumberOfPlayers = _cfg.allowedNumberOfPlayers,
            requestedCode = _roomCode,
        });

        UpdateStatus("CREATING SESSION…", $"ROOM: {_roomCode}", "Waiting for backend ack…");
    }

    private void HandleUnityCreated(string code, bool reattached)
    {
        _roomCode = code; // backend may normalize; trust backend
        EnterLobby();
    }

    private void HandleUnityError(string reason)
    {
        Fail($"Backend unityCreate failed: {reason}");
    }

    private void HandleBackendDisconnected(string reason)
    {
        Fail($"Backend disconnected: {reason}");
    }

    /* ============================
       Lobby / Game Start
    ============================ */

    private void EnterLobby()
    {
        SetState(BootState.Lobby);

        _manualStartRequested = false;

        _lobbyEndsAt = Time.time + Mathf.Max(0, _cfg.lobbyDurationSeconds);

        if (gameLogic != null) gameLogic.SetPhaseLobby(_roomCode);

        // Tell backend / players phase=join
        backend.SendUnityPhase(_roomCode, "join");

        UpdateStatus(
            "LOBBY",
            $"ROOM: {_roomCode}",
            $"Auto-start in {_cfg.lobbyDurationSeconds}s (press '{_cfg.allowManualStartKey}' to start)"
        );

        SetCodeText(_roomCode);

        // NOTE: Do not auto-bypass lobby on enter. Start should happen only by key press
        // or when the lobby timer naturally expires in Update().
    }

    private void BeginBufferCountdown()
    {
        if (_state != BootState.Lobby) return;

        SetState(BootState.BufferCountdown);

        int secs = gameLogic != null ? gameLogic.GetBufferCountdownSeconds() : 3;
        _bufferEndsAt = Time.time + secs;
        _bufferGoEndsAt = 0f;
        _bufferShowingGo = false;
        ShowExternalCountdown(Mathf.Max(1, secs).ToString());

        // Keep backend phase=join until BeginGame (taps gated by backend)
        if (gameLogic != null) gameLogic.SetPhaseBuffer(secs);

        // Intentionally do NOT emit "roundStarting" for Round 1 startup buffer.
        // Web should reserve "NEXT ROUND" UX for between-round transitions only.
    }

    private void BeginGame()
    {
        SetState(BootState.InGame);
        HideExternalCountdown();

        // Tell backend taps are now valid
        backend.SendUnityPhase(_roomCode, "active");

        // Tell game logic to start round 1
        if (gameLogic != null) gameLogic.StartGame(_roomCode);

        UpdateStatus("GAME ACTIVE", $"ROOM: {_roomCode}", "Taps are now counted.");
    }

    /* ============================
       TruckOfWar Backend → Unity events
    ============================ */

    private void HandleTowPlayerJoined(BackendConnector.TowPlayerJoinedMsg msg)
    {
        if (msg == null) return;

        if (playerSpawner != null)
            playerSpawner.SpawnOrAttach(msg.uid, msg.username, msg.teamIndex);

        if (gameLogic != null)
            gameLogic.OnPlayerJoined(msg.uid, msg.username, msg.teamIndex);
    }

    private void HandleTowPlayerResumed(BackendConnector.TowPlayerResumedMsg msg)
    {
        if (msg == null) return;

        if (playerSpawner != null)
            playerSpawner.SpawnOrAttach(msg.uid, msg.username, msg.teamIndex);

        if (gameLogic != null)
            gameLogic.OnPlayerJoined(msg.uid, msg.username, msg.teamIndex);
    }

    private void HandleTowPlayerLeft(BackendConnector.TowPlayerLeftMsg msg)
    {
        // For now we DO NOT despawn on disconnect (supports refresh/resume).
    }

    private void HandleTowTap(BackendConnector.TowTapMsg msg)
    {
        if (msg == null) return;

        if (gameLogic != null)
            gameLogic.OnTap(msg.uid, msg.username, msg.teamIndex, msg.count, msg.taps);

        if (playerSpawner != null)
        {
            var avatar = playerSpawner.GetAvatar(msg.uid);
            if (avatar != null)
            {
                var pl = avatar.GetComponent<PlayerLogic>();
                if (pl != null) pl.SetTotalTaps(msg.taps);
            }
        }
    }

    private void HandleTowRecordSaved(BackendConnector.TowRecordSavedMsg msg)
    {
        Debug.Log($"[TOW] recordSaved ok={msg.ok} key={msg.key} bucket={msg.bucket} reason={msg.reason}");

        if (msg?.topGtr != null && msg.topGtr.Length > 0)
        {
            Debug.Log("[TOW] Top 10 tappers (GTR):");
            for (int i = 0; i < msg.topGtr.Length; i++)
            {
                var row = msg.topGtr[i];
                if (row == null) continue;
                Debug.Log($"[TOW] #{i + 1} {row.username} - GTR {row.gtr}");
            }
        }
    }

    private void HandleTowPaused(BackendConnector.TowPausedMsg msg)
    {
        Debug.Log($"[TOW] paused reason={msg.reason}");
    }

    private void HandleTowEnded(BackendConnector.TowEndedMsg msg)
    {
        Debug.Log($"[TOW] ended reason={msg.reason}");
        // Optional: SetState(BootState.Ended);
    }

    private void HandleTowPhase(BackendConnector.TowPhaseMsg msg)
    {
        // Optional: react to backend phase broadcasts.
    }

    /* ============================
       Utilities
    ============================ */

    private void SetState(BootState s)
    {
        _state = s;
        SyncStartButtonState();
    }

    private void Fail(string reason)
    {
        SetState(BootState.Error);
        HideExternalCountdown();
        Debug.LogError("[Initializer] " + reason);
        UpdateStatus("ERROR", "", reason);
    }

    public void ShowExternalCountdown(string message)
    {
        if (!countdownText) return;
        if (!countdownText.gameObject.activeSelf)
            countdownText.gameObject.SetActive(true);
        countdownText.text = message;
    }

    public void HideExternalCountdown()
    {
        if (countdownText)
            countdownText.gameObject.SetActive(false);
    }

    private void SyncStartButtonState()
    {
        if (!startGameButton) return;
        startGameButton.interactable = _state == BootState.Lobby;
    }

    private void UpdateLobbyUI()
    {
        float remaining = Mathf.Max(0f, _lobbyEndsAt - Time.time);
        int r = Mathf.CeilToInt(remaining);

        string hint = $"Auto-start in {r}s";
        if (!string.IsNullOrEmpty(_cfg.allowManualStartKey))
            hint += $" (press '{_cfg.allowManualStartKey}' to start)";

        UpdateStatus("LOBBY", $"ROOM: {_roomCode}", hint);
        SetCodeText(_roomCode);
    }

    private void UpdateStatus(string state, string line2, string hint)
    {
        if (stateText) stateText.text = state;
        if (hintText) hintText.text = hint;
        if (codeText) codeText.text = line2;
    }

    private void SetCodeText(string code)
    {
        if (codeText) codeText.text = $"ROOM: {code}";
    }

    private bool IsManualStartPressed(string key)
    {
        if (string.IsNullOrEmpty(key)) return false;
        key = key.Trim().ToLowerInvariant();

        if (key.Length != 1) return false;

#if ENABLE_INPUT_SYSTEM
        char c = key[0];

        if (c >= 'a' && c <= 'z')
        {
            if (Enum.TryParse<Key>(c.ToString().ToUpperInvariant(), out var k))
            {
                return Keyboard.current != null && Keyboard.current[k].wasPressedThisFrame;
            }
            return false;
        }

        if (c >= '0' && c <= '9')
        {
            string name = "Digit" + c;
            if (Enum.TryParse<Key>(name, out var k))
            {
                return Keyboard.current != null && Keyboard.current[k].wasPressedThisFrame;
            }
            return false;
        }

        return false;
#else
        char c = key[0];

        if (c >= 'a' && c <= 'z')
        {
            KeyCode kc = (KeyCode)Enum.Parse(typeof(KeyCode), c.ToString().ToUpperInvariant());
            return Input.GetKeyDown(kc);
        }
        if (c >= '0' && c <= '9')
        {
            KeyCode kc = (KeyCode)Enum.Parse(typeof(KeyCode), "Alpha" + c);
            return Input.GetKeyDown(kc);
        }

        return false;
#endif
    }

    private string GenerateRoomCode(int lengthFromConfig)
    {
        const string letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        int length = Mathf.Clamp(lengthFromConfig <= 0 ? 4 : lengthFromConfig, 3, 8);

        StringBuilder sb = new StringBuilder(length);

        for (int i = 0; i < length; i++)
        {
            int index = UnityEngine.Random.Range(0, letters.Length);
            sb.Append(letters[index]);
        }

        return sb.ToString();
    }
}
