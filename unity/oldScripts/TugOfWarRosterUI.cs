using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEngine;

/// <summary>
///   • Lists rosters for Team A / Team B
///   • Counts each player’s pulls
///   • Displays “Top Player” for both teams
///   • Stops counting when either of two trigger objects becomes active
///   • Activates a results panel at that same moment
/// </summary>
public class TugOfWarRosterUI : MonoBehaviour
{
    [Header("Roster Text Objects")]
    [SerializeField] TMP_Text rosterAText;
    [SerializeField] TMP_Text rosterBText;

    [Header("Top-Player Text Objects")]
    [SerializeField] TMP_Text topAText;
    [SerializeField] TMP_Text topBText;

    [Header("Stop Counting When ANY of These Is Active")]
    [SerializeField] GameObject stopTrigger1;   // e.g. WinBannerA
    [SerializeField] GameObject stopTrigger2;   // e.g. WinBannerB

    [Header("Enable This GO When Counting Stops")]
    [SerializeField] GameObject enableOnStop;   // e.g. ResultsPanel

    /* ───────────────────────────────────────────────────────────── */

    readonly List<string> teamAPlayers = new();
    readonly List<string> teamBPlayers = new();
    readonly Dictionary<string, int> teamAPulls = new();
    readonly Dictionary<string, int> teamBPulls = new();

    bool countingStopped = false;

    public static TugOfWarRosterUI Instance { get; private set; }

    void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
    }

    /* ─────────────────────────────  JOIN  ───────────────────────────── */

    public void AddPlayer(string username, string team)
    {
        if (string.IsNullOrWhiteSpace(username)) return;

        if (IsTeamB(team))
        {
            if (teamBPlayers.Contains(username)) return;
            teamBPlayers.Add(username);
            teamBPulls.TryAdd(username, 0);
            RefreshRoster(rosterBText, teamBPlayers);
        }
        else
        {
            if (teamAPlayers.Contains(username)) return;
            teamAPlayers.Add(username);
            teamAPulls.TryAdd(username, 0);
            RefreshRoster(rosterAText, teamAPlayers);
        }

        Debug.Log($"[RosterUI] Added {username} to {(IsTeamB(team) ? "B" : "A")}");
    }

    /* ───────────────────────  PULL  (increment-first) ─────────────────────── */

    public void RegisterPull(string username, string team)
    {
        if (countingStopped) return;   // already frozen

        /* 1️⃣  increment */
        var dict = IsTeamB(team) ? teamBPulls : teamAPulls;
        if (!dict.ContainsKey(username)) dict[username] = 0;
        dict[username]++;

        /* 2️⃣  update label */
        UpdateTopPlayer(dict, IsTeamB(team) ? topBText : topAText);

        Debug.Log($"[RosterUI] Pull by {username}  newTotal={dict[username]}");

        /* 3️⃣  then check for victory banners */
        if (StopTriggered())
            StopCounting();
    }

    /* ────────────────────────────  FRAME CHECK  ──────────────────────────── */

    void Update()
    {
        if (!countingStopped && StopTriggered())
            StopCounting();
    }

    /* ────────────────────────────  RESET  ──────────────────────────── */

    public void ResetAll()
    {
        countingStopped = false;

        teamAPlayers.Clear(); teamBPlayers.Clear();
        teamAPulls.Clear(); teamBPulls.Clear();

        RefreshRoster(rosterAText, teamAPlayers);
        RefreshRoster(rosterBText, teamBPlayers);

        if (topAText) topAText.text = "-";
        if (topBText) topBText.text = "-";

        if (enableOnStop) enableOnStop.SetActive(false);

        Debug.Log("[RosterUI] Reset");
    }

    /* ───────────────────────────  HELPERS  ─────────────────────────── */

    bool StopTriggered() =>
        (stopTrigger1 && stopTrigger1.activeInHierarchy) ||
        (stopTrigger2 && stopTrigger2.activeInHierarchy);

    void StopCounting()
    {
        countingStopped = true;

        // final refresh ensures latest totals are shown
        UpdateTopPlayer(teamAPulls, topAText);
        UpdateTopPlayer(teamBPulls, topBText);

        if (enableOnStop) enableOnStop.SetActive(true);

        Debug.Log("[RosterUI] Counting stopped & results panel enabled");
    }

    static bool IsTeamB(string team) =>
        !string.IsNullOrEmpty(team) &&
        (team.Equals("B", System.StringComparison.OrdinalIgnoreCase) ||
         team.Equals("TeamB", System.StringComparison.OrdinalIgnoreCase));

    static void RefreshRoster(TMP_Text field, List<string> list)
    {
        if (field) field.text = string.Join("\n", list);
    }

    static void UpdateTopPlayer(Dictionary<string, int> pulls, TMP_Text field)
    {
        if (!field) return;

        if (pulls.Count == 0) { field.text = "-"; return; }

        var top = pulls.Aggregate((a, b) => a.Value >= b.Value ? a : b);
        field.text = $"{top.Key} ({top.Value})";
    }
}
