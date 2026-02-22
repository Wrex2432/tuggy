using System;
using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEngine;

/// <summary>
/// Legacy roster UI adapted for the current backend message model.
///
/// Supports both:
/// - Old calls: AddPlayer(username, team) / RegisterPull(username, team)
/// - New calls: OnPlayerJoined(uid, username, teamIndex) / OnTap(...)
/// </summary>
public class TugOfWarRosterUI : MonoBehaviour
{
    [Serializable]
    private class RosterEntry
    {
        public string uid;
        public string username;
        public int pulls;
    }

    [Header("Roster Text Objects")]
    [SerializeField] private TMP_Text rosterAText;
    [SerializeField] private TMP_Text rosterBText;

    [Header("Top-Player Text Objects")]
    [SerializeField] private TMP_Text topAText;
    [SerializeField] private TMP_Text topBText;

    [Header("Stop Counting When ANY of These Is Active")]
    [SerializeField] private GameObject stopTrigger1;
    [SerializeField] private GameObject stopTrigger2;

    [Header("Enable This GO When Counting Stops")]
    [SerializeField] private GameObject enableOnStop;

    private readonly Dictionary<string, RosterEntry> _teamA = new();
    private readonly Dictionary<string, RosterEntry> _teamB = new();

    private bool countingStopped;

    public static TugOfWarRosterUI Instance { get; private set; }

    private void Awake()
    {
        if (Instance != null && Instance != this)
        {
            Destroy(gameObject);
            return;
        }

        Instance = this;
        RefreshAll();
    }

    // ---------- New system API ----------

    public void OnPlayerJoined(string uid, string username, int teamIndex)
    {
        if (string.IsNullOrWhiteSpace(uid)) return;

        Dictionary<string, RosterEntry> own = TeamMap(teamIndex);
        Dictionary<string, RosterEntry> other = teamIndex == 1 ? _teamA : _teamB;

        // Ensure uid is only in one team dictionary.
        other.Remove(uid);

        if (!own.TryGetValue(uid, out var entry))
        {
            own[uid] = new RosterEntry
            {
                uid = uid,
                username = SafeName(username),
                pulls = 0
            };
        }
        else
        {
            entry.username = SafeName(username);
        }

        RefreshAll();
    }

    public void OnPlayerResumed(string uid, string username, int teamIndex)
    {
        OnPlayerJoined(uid, username, teamIndex);
    }

    public void OnTap(string uid, string username, int teamIndex, int count)
    {
        if (countingStopped) return;
        if (string.IsNullOrWhiteSpace(uid)) return;

        Dictionary<string, RosterEntry> own = TeamMap(teamIndex);
        if (!own.TryGetValue(uid, out var entry))
        {
            entry = new RosterEntry
            {
                uid = uid,
                username = SafeName(username),
                pulls = 0
            };
            own[uid] = entry;
        }

        entry.username = SafeName(username);
        entry.pulls += Mathf.Max(1, count);

        RefreshTopLabels();

        if (StopTriggered())
            StopCounting();
    }

    public void ApplyBackendPhase(string phase)
    {
        if (string.IsNullOrWhiteSpace(phase)) return;

        string normalized = phase.Trim().ToLowerInvariant();

        if (normalized == "join")
        {
            ResetAll();
        }
        else if (normalized == "ended")
        {
            StopCounting();
        }
    }

    // ---------- Legacy compatibility API ----------

    public void AddPlayer(string username, string team)
    {
        // Legacy flow has no uid, so derive a stable local key from team + name.
        string key = $"legacy:{(IsTeamB(team) ? 1 : 0)}:{SafeName(username).ToLowerInvariant()}";
        OnPlayerJoined(key, username, IsTeamB(team) ? 1 : 0);
    }

    public void RegisterPull(string username, string team)
    {
        string key = $"legacy:{(IsTeamB(team) ? 1 : 0)}:{SafeName(username).ToLowerInvariant()}";
        OnTap(key, username, IsTeamB(team) ? 1 : 0, 1);
    }

    private void Update()
    {
        if (!countingStopped && StopTriggered())
            StopCounting();
    }

    public void ResetAll()
    {
        countingStopped = false;

        _teamA.Clear();
        _teamB.Clear();

        RefreshAll();

        if (enableOnStop) enableOnStop.SetActive(false);
    }

    private bool StopTriggered()
    {
        return (stopTrigger1 && stopTrigger1.activeInHierarchy) ||
               (stopTrigger2 && stopTrigger2.activeInHierarchy);
    }

    private void StopCounting()
    {
        countingStopped = true;
        RefreshTopLabels();

        if (enableOnStop) enableOnStop.SetActive(true);
    }

    private void RefreshAll()
    {
        RefreshRoster(rosterAText, _teamA.Values.Select(v => v.username));
        RefreshRoster(rosterBText, _teamB.Values.Select(v => v.username));
        RefreshTopLabels();
    }

    private void RefreshTopLabels()
    {
        UpdateTopPlayer(_teamA, topAText);
        UpdateTopPlayer(_teamB, topBText);
    }

    private static Dictionary<string, RosterEntry> TeamMapByIndex(
        int teamIndex,
        Dictionary<string, RosterEntry> teamA,
        Dictionary<string, RosterEntry> teamB)
    {
        return teamIndex == 1 ? teamB : teamA;
    }

    private Dictionary<string, RosterEntry> TeamMap(int teamIndex)
    {
        return TeamMapByIndex(teamIndex, _teamA, _teamB);
    }

    private static bool IsTeamB(string team)
    {
        return !string.IsNullOrWhiteSpace(team) &&
               (team.Equals("B", StringComparison.OrdinalIgnoreCase) ||
                team.Equals("TeamB", StringComparison.OrdinalIgnoreCase) ||
                team.Equals("1", StringComparison.OrdinalIgnoreCase));
    }

    private static string SafeName(string username)
    {
        string trimmed = (username ?? string.Empty).Trim();
        return string.IsNullOrEmpty(trimmed) ? "Unknown" : trimmed;
    }

    private static void RefreshRoster(TMP_Text field, IEnumerable<string> names)
    {
        if (field) field.text = string.Join("\n", names);
    }

    private static void UpdateTopPlayer(Dictionary<string, RosterEntry> pulls, TMP_Text field)
    {
        if (!field) return;

        if (pulls.Count == 0)
        {
            field.text = "-";
            return;
        }

        var top = pulls.Values
            .OrderByDescending(p => p.pulls)
            .ThenBy(p => p.username, StringComparer.OrdinalIgnoreCase)
            .First();

        field.text = $"{top.username} ({top.pulls})";
    }
}
