using System;
using System.Collections.Generic;
using UnityEngine;

/// ---------------------------------------------------------------------------
/// TugOfWarManager
///  • Transform-only rope
///  • Momentum with decay (old-school feel)
///  • Normalises pulls by player-count
///  • Enables win-objects on victory
/// ---------------------------------------------------------------------------
public class TugOfWarManager : MonoBehaviour
{
    public enum Team { A, B }

    // ───────────── References ─────────────
    [Header("Pivot / Rope")]
    [SerializeField] private Transform pivot;

    [Header("Win Objects")]
    [Tooltip("Enable when Team A wins")]
    [SerializeField] private GameObject teamAWinObject;
    [Tooltip("Enable when Team B wins")]
    [SerializeField] private GameObject teamBWinObject;

    // ───────────── Movement Tuning ─────────────
    [Header("Movement")]
    [SerializeField] private float movementFactor = 0.2f;
    [SerializeField] private float movementSpeed = 5f;

    [Header("Click Momentum")]
    [SerializeField] private float clickImpulse = 1f;
    [SerializeField] private float speedDecay = 1f;

    [Header("Win Condition")]
    [SerializeField] private float winThreshold = 6f;

    // ───────────── Runtime state ─────────────
    private readonly Dictionary<Team, int> playersOnTeam = new()
    {
        { Team.A, 0 }, { Team.B, 0 }
    };

    private float teamASpeed, teamBSpeed;
    private Vector3 startPos;

    public static TugOfWarManager Instance { get; private set; }
    public Action<Team> OnTeamWin;

    // ─────────────────────────────────────────

    void Awake()
    {
        if (Instance && Instance != this) { Destroy(gameObject); return; }
        Instance = this;

        if (pivot == null)
            Debug.LogError("[TugOfWarManager] Pivot reference missing!");

        startPos = pivot != null ? pivot.localPosition : Vector3.zero;

        // make sure win objects start hidden
        if (teamAWinObject) teamAWinObject.SetActive(false);
        if (teamBWinObject) teamBWinObject.SetActive(false);
    }

    // ---------- Public API ----------

    public void RegisterPlayer(Team team) => playersOnTeam[team]++;

    public void RegisterPull(Team team)
    {
        int count = playersOnTeam[team] > 0 ? playersOnTeam[team] : 1;
        float impulse = clickImpulse / count;

        if (team == Team.A) teamASpeed += impulse;
        else teamBSpeed += impulse;
    }

    public void ResetRound()
    {
        pivot.localPosition = startPos;
        teamASpeed = teamBSpeed = 0f;

        if (teamAWinObject) teamAWinObject.SetActive(false);
        if (teamBWinObject) teamBWinObject.SetActive(false);

        enabled = true;
    }

    // ---------- Update loop ----------

    void Update()
    {
        if (!enabled || pivot == null) return;

        float dt = Time.deltaTime;

        // 1️⃣  Decay
        teamASpeed = Mathf.Max(0f, teamASpeed - speedDecay * dt);
        teamBSpeed = Mathf.Max(0f, teamBSpeed - speedDecay * dt);

        // 2️⃣  Target position
        float diff = teamBSpeed - teamASpeed;    // +right / –left
        Vector3 tgt = startPos + new Vector3(diff * movementFactor, 0f, 0f);

        // 3️⃣  Lerp
        pivot.localPosition = Vector3.Lerp(pivot.localPosition, tgt, dt * movementSpeed);

        // 4️⃣  Win check
        float offset = pivot.localPosition.x - startPos.x;
        if (offset >= winThreshold) DeclareWin(Team.B);
        if (offset <= -winThreshold) DeclareWin(Team.A);
    }

    private void DeclareWin(Team winner)
    {
        enabled = false;

        // show the appropriate object
        if (winner == Team.A && teamAWinObject) teamAWinObject.SetActive(true);
        if (winner == Team.B && teamBWinObject) teamBWinObject.SetActive(true);

        Debug.Log($"[TugOfWar] Team {winner} wins!");
        OnTeamWin?.Invoke(winner);
    }
}
