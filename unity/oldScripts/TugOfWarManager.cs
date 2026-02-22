using System;
using System.Collections.Generic;
using UnityEngine;

namespace Tuggy.LegacyUI
{
/// <summary>
/// Legacy tug movement manager adapted for the current TruckOfWar backend flow.
///
/// Supports both:
/// - Old calls: RegisterPlayer(Team) / RegisterPull(Team)
/// - New calls: OnPlayerJoined(uid, username, teamIndex) / OnTap(...)
///
/// teamIndex mapping:
/// - 0 = Team A
/// - 1 = Team B
/// </summary>
public class TugOfWarManager : MonoBehaviour
{
    public enum Team { A = 0, B = 1 }

    [Header("Pivot / Rope")]
    [SerializeField] private Transform pivot;

    [Header("Win Objects")]
    [SerializeField] private GameObject teamAWinObject;
    [SerializeField] private GameObject teamBWinObject;

    [Header("Movement")]
    [SerializeField] private float movementFactor = 0.2f;
    [SerializeField] private float movementSpeed = 5f;

    [Header("Click Momentum")]
    [SerializeField] private float clickImpulse = 1f;
    [SerializeField] private float speedDecay = 1f;

    [Header("Win Condition")]
    [SerializeField] private float winThreshold = 6f;

    private readonly Dictionary<Team, int> playersOnTeam = new()
    {
        { Team.A, 0 },
        { Team.B, 0 }
    };

    private readonly HashSet<string> _teamAUids = new();
    private readonly HashSet<string> _teamBUids = new();

    private float teamASpeed;
    private float teamBSpeed;
    private Vector3 startPos;

    public static TugOfWarManager Instance { get; private set; }
    public Action<Team> OnTeamWin;

    private void Awake()
    {
        if (Instance && Instance != this)
        {
            Destroy(gameObject);
            return;
        }

        Instance = this;

        if (pivot == null)
            Debug.LogError("[TugOfWarManager] Pivot reference missing.");

        startPos = pivot != null ? pivot.localPosition : Vector3.zero;

        if (teamAWinObject) teamAWinObject.SetActive(false);
        if (teamBWinObject) teamBWinObject.SetActive(false);
    }

    public void RegisterPlayer(Team team)
    {
        playersOnTeam[team]++;
    }

    public void RegisterPull(Team team, int count = 1)
    {
        int safeCount = Mathf.Max(1, count);
        int playerCount = playersOnTeam[team] > 0 ? playersOnTeam[team] : 1;
        float impulse = (clickImpulse * safeCount) / playerCount;

        if (team == Team.A) teamASpeed += impulse;
        else teamBSpeed += impulse;
    }

    /// <summary>
    /// New-system helper: call from backend join/resume handlers.
    /// </summary>
    public void OnPlayerJoined(string uid, string username, int teamIndex)
    {
        if (string.IsNullOrWhiteSpace(uid)) return;

        Team team = TeamFromIndex(teamIndex);
        var ownSet = team == Team.A ? _teamAUids : _teamBUids;
        var otherSet = team == Team.A ? _teamBUids : _teamAUids;

        // Handle late correction if player rejoins with a different team index.
        if (otherSet.Remove(uid))
        {
            playersOnTeam[team == Team.A ? Team.B : Team.A] = Mathf.Max(0, playersOnTeam[team == Team.A ? Team.B : Team.A] - 1);
        }

        if (ownSet.Add(uid))
            RegisterPlayer(team);
    }

    /// <summary>
    /// New-system helper: call from backend tap handler.
    /// </summary>
    public void OnTap(string uid, string username, int teamIndex, int count)
    {
        if (!enabled) return;
        RegisterPull(TeamFromIndex(teamIndex), Mathf.Max(1, count));
    }

    /// <summary>
    /// Optional integration point for backend phase events (join/active/ended).
    /// </summary>
    public void ApplyBackendPhase(string phase)
    {
        if (string.IsNullOrWhiteSpace(phase)) return;

        string p = phase.Trim().ToLowerInvariant();
        if (p == "active")
        {
            enabled = true;
            return;
        }

        if (p == "join" || p == "buffer")
        {
            ResetRound();
            return;
        }

        if (p == "ended")
        {
            enabled = false;
        }
    }

    public void ResetRound()
    {
        if (pivot) pivot.localPosition = startPos;

        teamASpeed = 0f;
        teamBSpeed = 0f;

        if (teamAWinObject) teamAWinObject.SetActive(false);
        if (teamBWinObject) teamBWinObject.SetActive(false);

        enabled = true;
    }

    private void Update()
    {
        if (!enabled || pivot == null) return;

        float dt = Time.deltaTime;

        teamASpeed = Mathf.Max(0f, teamASpeed - speedDecay * dt);
        teamBSpeed = Mathf.Max(0f, teamBSpeed - speedDecay * dt);

        float diff = teamBSpeed - teamASpeed;
        Vector3 target = startPos + new Vector3(diff * movementFactor, 0f, 0f);
        pivot.localPosition = Vector3.Lerp(pivot.localPosition, target, dt * movementSpeed);

        float offset = pivot.localPosition.x - startPos.x;
        if (offset >= winThreshold) DeclareWin(Team.B);
        else if (offset <= -winThreshold) DeclareWin(Team.A);
    }

    private void DeclareWin(Team winner)
    {
        enabled = false;

        if (winner == Team.A && teamAWinObject) teamAWinObject.SetActive(true);
        if (winner == Team.B && teamBWinObject) teamBWinObject.SetActive(true);

        Debug.Log($"[TugOfWarManager] Team {winner} wins.");
        OnTeamWin?.Invoke(winner);
    }

    private static Team TeamFromIndex(int teamIndex)
    {
        return teamIndex == 1 ? Team.B : Team.A;
    }
}
}
