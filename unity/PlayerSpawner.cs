// PlayerSpawner.cs
// Truck Of War — Spawns/attaches player avatars when backend reports joins/resumes.
//
// Responsibilities:
// - Maintain mapping uid -> spawned avatar
// - Spawn new avatar if uid not present
// - Position avatars by team lanes (Team A left, Team B right)
// - Attach/init PlayerLogic on the avatar
// - Provide a clean API: SpawnOrAttach(uid, username, teamIndex)
//
// Notes:
// - This is bare-bones. No fancy UI.
// - You can swap to pooled objects later if needed.

using System;
using System.Collections.Generic;
using UnityEngine;

public class PlayerSpawner : MonoBehaviour
{
    [Serializable]
    public class LaneSettings
    {
        [Tooltip("Where Team A players are placed (left side).")]
        public Transform teamAAnchor;

        [Tooltip("Where Team B players are placed (right side).")]
        public Transform teamBAnchor;

        [Tooltip("Spacing between players in a team lane (world units).")]
        public float spacing = 1.25f;

        [Tooltip("Direction to stack players from anchor (usually +Y or +Z depending on your scene).")]
        public Vector3 stackDirection = Vector3.up;

        [Tooltip("Optional: per-team additional offset.")]
        public Vector3 teamAOffset = Vector3.zero;
        public Vector3 teamBOffset = Vector3.zero;
    }

    [Header("Prefab")]
    [SerializeField] private GameObject playerAvatarPrefab;

    [Header("Lane Placement")]
    [SerializeField] private LaneSettings lanes = new LaneSettings();

    [Header("Debug")]
    [SerializeField] private bool verboseLogs = true;

    private Initializer.ControlConfig _cfg;

    // uid -> avatar
    private readonly Dictionary<string, GameObject> _avatarsByUid = new Dictionary<string, GameObject>();

    // Team rosters (for placement)
    private readonly List<string> _teamAUids = new List<string>();
    private readonly List<string> _teamBUids = new List<string>();

    public void ApplyConfig(Initializer.ControlConfig cfg)
    {
        _cfg = cfg;
    }

    public bool HasPlayer(string uid)
    {
        return !string.IsNullOrEmpty(uid) && _avatarsByUid.ContainsKey(uid);
    }

    public GameObject GetAvatar(string uid)
    {
        if (string.IsNullOrEmpty(uid)) return null;
        _avatarsByUid.TryGetValue(uid, out var go);
        return go;
    }

    /// <summary>
    /// Spawn new avatar if not existing. If existing, update name/team.
    /// teamIndex: 0 Team A (left) | 1 Team B (right)
    /// </summary>
    public void SpawnOrAttach(string uid, string username, int teamIndex)
    {
        if (string.IsNullOrEmpty(uid))
        {
            if (verboseLogs) Debug.LogWarning("[PlayerSpawner] SpawnOrAttach called with empty uid");
            return;
        }

        // If already exists, just update data and ensure roster
        if (_avatarsByUid.TryGetValue(uid, out var existing))
        {
            EnsureRoster(uid, teamIndex);
            UpdatePlayerLogic(existing, uid, username, teamIndex);
            RepositionTeam(teamIndex);
            return;
        }

        if (playerAvatarPrefab == null)
        {
            Debug.LogError("[PlayerSpawner] Missing playerAvatarPrefab");
            return;
        }

        var avatar = Instantiate(playerAvatarPrefab, transform);
        avatar.name = $"Player_{teamIndex}_{Sanitize(username)}_{uid.Substring(0, Math.Min(6, uid.Length))}";

        _avatarsByUid[uid] = avatar;

        EnsureRoster(uid, teamIndex);

        // Ensure PlayerLogic exists
        var logic = avatar.GetComponent<PlayerLogic>();
        if (logic == null) logic = avatar.AddComponent<PlayerLogic>();

        logic.Init(uid, username, teamIndex);

        // Place it
        PositionSingle(uid, teamIndex);

        if (verboseLogs)
        {
            Debug.Log($"[PlayerSpawner] Spawned uid={uid} user={username} team={teamIndex}");
        }
    }

    /// <summary>
    /// Optional: remove player avatar if you choose to remove on disconnect.
    /// (In your flow, players can reload and resume; so removal is optional.)
    /// </summary>
    public void RemovePlayer(string uid)
    {
        if (string.IsNullOrEmpty(uid)) return;

        if (_avatarsByUid.TryGetValue(uid, out var go))
        {
            _avatarsByUid.Remove(uid);
            _teamAUids.Remove(uid);
            _teamBUids.Remove(uid);
            Destroy(go);
            RepositionAll();
        }
    }

    /// <summary>
    /// Optional: clear everything (e.g., new session).
    /// </summary>
    public void ClearAll()
    {
        foreach (var kv in _avatarsByUid)
        {
            if (kv.Value) Destroy(kv.Value);
        }
        _avatarsByUid.Clear();
        _teamAUids.Clear();
        _teamBUids.Clear();
    }

    /* ============================
       Placement helpers
    ============================ */

    private void EnsureRoster(string uid, int teamIndex)
    {
        // Remove from both lists first (safe)
        _teamAUids.Remove(uid);
        _teamBUids.Remove(uid);

        if (teamIndex == 0)
        {
            _teamAUids.Add(uid);
        }
        else
        {
            _teamBUids.Add(uid);
        }
    }

    private void RepositionAll()
    {
        RepositionTeam(0);
        RepositionTeam(1);
    }

    private void RepositionTeam(int teamIndex)
    {
        if (teamIndex == 0)
        {
            for (int i = 0; i < _teamAUids.Count; i++)
            {
                PositionByIndex(_teamAUids[i], 0, i);
            }
        }
        else
        {
            for (int i = 0; i < _teamBUids.Count; i++)
            {
                PositionByIndex(_teamBUids[i], 1, i);
            }
        }
    }

    private void PositionSingle(string uid, int teamIndex)
    {
        if (teamIndex == 0)
        {
            int idx = _teamAUids.IndexOf(uid);
            if (idx < 0) idx = _teamAUids.Count - 1;
            PositionByIndex(uid, 0, idx);
            return;
        }
        else
        {
            int idx = _teamBUids.IndexOf(uid);
            if (idx < 0) idx = _teamBUids.Count - 1;
            PositionByIndex(uid, 1, idx);
            return;
        }
    }

    private void PositionByIndex(string uid, int teamIndex, int index)
    {
        if (!_avatarsByUid.TryGetValue(uid, out var go) || go == null) return;

        Transform anchor = (teamIndex == 0) ? lanes.teamAAnchor : lanes.teamBAnchor;
        if (anchor == null)
        {
            // Fallback: place around spawner origin
            anchor = this.transform;
        }

        Vector3 basePos = anchor.position;
        Vector3 offsetTeam = (teamIndex == 0) ? lanes.teamAOffset : lanes.teamBOffset;

        Vector3 stacked = lanes.stackDirection.normalized * (lanes.spacing * index);
        Vector3 finalPos = basePos + offsetTeam + stacked;

        go.transform.position = finalPos;

        // Optional: face center / marker
        // (You can do this later if needed.)
    }

    private void UpdatePlayerLogic(GameObject avatar, string uid, string username, int teamIndex)
    {
        if (!avatar) return;
        var logic = avatar.GetComponent<PlayerLogic>();
        if (logic == null) logic = avatar.AddComponent<PlayerLogic>();

        // Update/refresh
        logic.Init(uid, username, teamIndex);
    }

    private string Sanitize(string s)
    {
        if (string.IsNullOrEmpty(s)) return "Player";
        s = s.Trim();
        // Keep it simple: letters/numbers/underscore
        var chars = s.ToCharArray();
        for (int i = 0; i < chars.Length; i++)
        {
            char c = chars[i];
            bool ok = (c >= 'a' && c <= 'z') ||
                      (c >= 'A' && c <= 'Z') ||
                      (c >= '0' && c <= '9') ||
                      c == '_' || c == '-';
            if (!ok) chars[i] = '_';
        }
        return new string(chars);
    }
}
