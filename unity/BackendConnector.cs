// BackendConnector.cs
// Truck Of War — WebSocket bridge ONLY (no game logic)
//
// Responsibilities:
// - Connect to EC2 WebSocket
// - Send unityCreate / unityMsg (phase + gameOver)
// - Receive adapter -> Unity messages for TruckOfWar:
//    - playerJoined / playerResumed / playerLeft
//    - tap
//    - paused / ended
//    - recordSaved
//
// IMPORTANT:
// - This connector expects server.js routing:
//    Unity sends: { type:"unityCreate", ... } then later { type:"unityMsg", code, payload:{} }
//    Adapter sends to Unity: JSON messages WITHOUT wrapper, via safeSend(unity.ws, obj)
//   In our truckofwar.js we emit:
//    { type:"playerJoined", uid, username, teamIndex, ... }
//    { type:"playerResumed", ... }
//    { type:"playerLeft", ... }
//    { type:"tap", uid, username, teamIndex, count, taps }
//    { type:"recordSaved", ok, key, bucket, reason, ... }
//
// Notes:
// - Uses NativeWebSocket (recommended for Unity). Install via:
//   Window > Package Manager > + (Add package from git URL)
//   https://github.com/endel/NativeWebSocket.git
//
// If you already have a WebSocket lib you prefer, tell me and I’ll adapt.

using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using UnityEngine;

#if !UNITY_WEBGL || UNITY_EDITOR
using NativeWebSocket;
#endif

public class BackendConnector : MonoBehaviour
{
    [Header("Server")]
    [SerializeField] private string serverUrl = "wss://api.prologuebymetama.com/ws";

    [Header("Debug")]
    [SerializeField] private bool verboseLogs = true;

#if !UNITY_WEBGL || UNITY_EDITOR
    private WebSocket _ws;
#endif

    private bool _connecting = false;
    private bool _connected = false;

    private string _sessionCode = ""; // set after unityCreated ok

    /* ============================
       Public events (Initializer/GameLogic/Spawner listen to these)
    ============================ */

    public event Action OnConnected;
    public event Action<string> OnDisconnected;

    // UnityCreate response
    public event Action<string, bool> OnUnityCreated; // (code, reattached)
    public event Action<string> OnUnityError;         // reason string

    // TruckOfWar adapter -> Unity
    public event Action<TowPlayerJoinedMsg> OnTowPlayerJoined;
    public event Action<TowPlayerResumedMsg> OnTowPlayerResumed;
    public event Action<TowPlayerLeftMsg> OnTowPlayerLeft;
    public event Action<TowTapMsg> OnTowTap;
    public event Action<TowPhaseMsg> OnTowPhase;
    public event Action<TowPausedMsg> OnTowPaused;
    public event Action<TowEndedMsg> OnTowEnded;
    public event Action<TowRecordSavedMsg> OnTowRecordSaved;

    /* ============================
       Message DTOs
    ============================ */

    [Serializable]
    public class UnityCreateMsg
    {
        public string type = "unityCreate";
        public string gameType;
        public string location;
        public int teamCount = 2;
        public int allowedNumberOfPlayers;
        public string requestedCode;
    }

    [Serializable]
    public class UnityMsgEnvelope
    {
        public string type = "unityMsg";
        public string code;
        public object payload;
    }

    [Serializable]
    public class UnityCreatedResultMsg
    {
        public string type;
        public bool ok;
        public string code;
        public bool reattached;
        public string reason;
        public object snapshot;
    }

    // Adapter messages (truckofwar.js)
    [Serializable]
    public class TowPlayerJoinedMsg
    {
        public string type; // "playerJoined"
        public string uid;
        public string username;
        public int teamIndex;
        public string team;
        public object snapshot;
    }

    [Serializable]
    public class TowPlayerResumedMsg
    {
        public string type; // "playerResumed"
        public string uid;
        public string username;
        public int teamIndex;
        public string team;
        public object snapshot;
    }

    [Serializable]
    public class TowPlayerLeftMsg
    {
        public string type; // "playerLeft"
        public string uid;
        public string username;
        public object snapshot;
    }

    [Serializable]
    public class TowTapMsg
    {
        public string type; // "tap"
        public string uid;
        public string username;
        public int teamIndex;
        public int count;
        public int taps;
    }

    [Serializable]
    public class TowPhaseMsg
    {
        public string type;  // "phase"
        public string phase; // "join" | "active" | "ended"
        public string reason;
    }

    [Serializable]
    public class TowPausedMsg
    {
        public string type;   // "paused"
        public string reason; // "unity_disconnected"
    }

    [Serializable]
    public class TowEndedMsg
    {
        public string type;   // "ended"
        public string reason; // "unity_disconnected_timeout" etc
    }

    [Serializable]
    public class TowTopTapper
    {
        public string username;
        public int gtr;
    }

    [Serializable]
    public class TowRecordSavedMsg
    {
        public string type;   // "recordSaved"
        public bool ok;
        public string key;
        public string bucket;
        public string reason;
        public string endedReason;
        public string winningTeam;
        public TowTopTapper[] topGtr;
    }

    // Generic wrapper to quickly read "type"
    private class TypeOnly
    {
        public string type;
    }

    /* ============================
       Public API
    ============================ */

    public void SetServerUrl(string url)
    {
        serverUrl = url;
    }

    public bool IsConnected()
    {
        return _connected;
    }

    public string GetSessionCode()
    {
        return _sessionCode;
    }

    public void Connect()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        Debug.LogError("[BackendConnector] WebGL build requires a WebSocket implementation compatible with WebGL. Install NativeWebSocket and ensure WebGL support.");
        return;
#else
        if (_connecting || _connected) return;
        if (string.IsNullOrWhiteSpace(serverUrl))
        {
            Debug.LogError("[BackendConnector] Missing serverUrl");
            return;
        }

        _connecting = true;

        if (verboseLogs) Debug.Log($"[BackendConnector] Connecting to {serverUrl} …");

        _ws = new WebSocket(serverUrl);

        _ws.OnOpen += () =>
        {
            _connecting = false;
            _connected = true;
            if (verboseLogs) Debug.Log("[BackendConnector] Connected");
            OnConnected?.Invoke();
        };

        _ws.OnError += (e) =>
        {
            _connecting = false;
            _connected = false;
            Debug.LogError("[BackendConnector] WS error: " + e);
            OnDisconnected?.Invoke("ws_error");
        };

        _ws.OnClose += (e) =>
        {
            _connecting = false;
            _connected = false;
            if (verboseLogs) Debug.Log($"[BackendConnector] Disconnected (code={e})");
            OnDisconnected?.Invoke($"ws_closed_{e}");
        };

        _ws.OnMessage += (bytes) =>
        {
            try
            {
                string json = System.Text.Encoding.UTF8.GetString(bytes);
                HandleInboundJson(json);
            }
            catch (Exception ex)
            {
                Debug.LogError("[BackendConnector] OnMessage parse exception: " + ex.Message);
            }
        };

        _ws.Connect();
#endif
    }

    public async void Disconnect()
    {
#if !UNITY_WEBGL || UNITY_EDITOR
        try
        {
            if (_ws != null)
            {
                await _ws.Close();
            }
        }
        catch { }
#endif
    }

    public void SendUnityCreate(UnityCreateMsg msg)
    {
        if (msg == null) return;
        if (string.IsNullOrWhiteSpace(msg.requestedCode))
        {
            Debug.LogError("[BackendConnector] unityCreate missing requestedCode");
            return;
        }
        SendJson(msg);
    }

    // Send phase transition: "join" | "active" | "ended"
    public void SendUnityPhase(string roomCode, string phase)
    {
        var payload = new Dictionary<string, object>
        {
            { "kind", "phase" },
            { "phase", phase }
        };
        SendUnityMsg(roomCode, payload);
    }

    // Send gameOver with winning teamIndex (0 Team A, 1 Team B)
    public void SendUnityGameOver(string roomCode, int winnerTeamIndex)
    {
        var payload = new Dictionary<string, object>
        {
            { "kind", "gameOver" },
            { "winnerTeamIndex", winnerTeamIndex }
        };
        SendUnityMsg(roomCode, payload);
    }

    // Generic unityMsg
    public void SendUnityMsg(string roomCode, object payload)
    {
        if (string.IsNullOrWhiteSpace(roomCode))
        {
            // fallback: if we already have session code, use it
            if (!string.IsNullOrWhiteSpace(_sessionCode))
                roomCode = _sessionCode;
        }

        if (string.IsNullOrWhiteSpace(roomCode))
        {
            Debug.LogError("[BackendConnector] unityMsg missing code");
            return;
        }

        var env = new UnityMsgEnvelope
        {
            type = "unityMsg",
            code = roomCode,
            payload = payload
        };

        SendJson(env);
    }

    /* ============================
       Internal send
    ============================ */

    private async void SendJson(object obj)
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        return;
#else
        if (_ws == null || !_connected) return;

        try
        {
            string json = JsonConvert.SerializeObject(obj);
            if (verboseLogs) Debug.Log("[BackendConnector] >> " + json);
            await _ws.SendText(json);
        }
        catch (Exception e)
        {
            Debug.LogError("[BackendConnector] Send failed: " + e.Message);
        }
#endif
    }

    /* ============================
       Inbound routing
    ============================ */

    private void HandleInboundJson(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return;

        if (verboseLogs) Debug.Log("[BackendConnector] << " + json);

        TypeOnly t;
        try
        {
            t = JsonConvert.DeserializeObject<TypeOnly>(json);
        }
        catch
        {
            return;
        }

        if (t == null || string.IsNullOrWhiteSpace(t.type)) return;

        switch (t.type)
        {
            // Server unityCreate response
            case "unityCreated":
                {
                    var m = JsonConvert.DeserializeObject<UnityCreatedResultMsg>(json);
                    if (m == null) return;

                    if (!m.ok)
                    {
                        OnUnityError?.Invoke(string.IsNullOrWhiteSpace(m.reason) ? "unityCreate_failed" : m.reason);
                        return;
                    }

                    _sessionCode = m.code ?? _sessionCode;
                    OnUnityCreated?.Invoke(_sessionCode, m.reattached);
                    return;
                }

            // TruckOfWar adapter messages to Unity
            case "playerJoined":
                {
                    var m = JsonConvert.DeserializeObject<TowPlayerJoinedMsg>(json);
                    if (m == null) return;
                    OnTowPlayerJoined?.Invoke(m);
                    return;
                }

            case "playerResumed":
                {
                    var m = JsonConvert.DeserializeObject<TowPlayerResumedMsg>(json);
                    if (m == null) return;
                    OnTowPlayerResumed?.Invoke(m);
                    return;
                }

            case "playerLeft":
                {
                    var m = JsonConvert.DeserializeObject<TowPlayerLeftMsg>(json);
                    if (m == null) return;
                    OnTowPlayerLeft?.Invoke(m);
                    return;
                }

            case "tap":
                {
                    var m = JsonConvert.DeserializeObject<TowTapMsg>(json);
                    if (m == null) return;
                    OnTowTap?.Invoke(m);
                    return;
                }

            case "phase":
                {
                    var m = JsonConvert.DeserializeObject<TowPhaseMsg>(json);
                    if (m == null) return;
                    OnTowPhase?.Invoke(m);
                    return;
                }

            case "paused":
                {
                    var m = JsonConvert.DeserializeObject<TowPausedMsg>(json);
                    if (m == null) return;
                    OnTowPaused?.Invoke(m);
                    return;
                }

            case "ended":
                {
                    var m = JsonConvert.DeserializeObject<TowEndedMsg>(json);
                    if (m == null) return;
                    OnTowEnded?.Invoke(m);
                    return;
                }

            case "recordSaved":
                {
                    var m = JsonConvert.DeserializeObject<TowRecordSavedMsg>(json);
                    if (m == null) return;
                    OnTowRecordSaved?.Invoke(m);
                    return;
                }
        }

        // Unknown message type: ignore (keeps it independent)
    }

    /* ============================
       Unity lifecycle hooks
    ============================ */

    private void Update()
    {
#if !UNITY_WEBGL || UNITY_EDITOR
        // Required by NativeWebSocket to dispatch events on main thread
        _ws?.DispatchMessageQueue();
#endif
    }

    private void OnApplicationQuit()
    {
        Disconnect();
    }
}
