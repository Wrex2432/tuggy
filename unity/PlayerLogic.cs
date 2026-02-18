// PlayerLogic.cs
// Truck Of War — per-player component attached to each spawned avatar.
//
// Responsibilities:
// - Store identity: uid, username, teamIndex
// - Store taps (total taps, last delta)
// - Optional: simple visuals (name text, tap text) if assigned
//
// Notes:
// - GameLogic should be the one calling AddTaps / SetTotalTaps when tap messages arrive.
// - This script does NOT talk to backend.

using System;
using UnityEngine;
using UnityEngine.UI;

public class PlayerLogic : MonoBehaviour
{
    [Header("Identity (read-only at runtime)")]
    [SerializeField] private string uid;
    [SerializeField] private string username;
    [SerializeField] private int teamIndex; // 0 Team A | 1 Team B

    [Header("Tap Stats")]
    [SerializeField] private int totalTaps = 0;
    [SerializeField] private int lastTapDelta = 0;

    [Header("Optional UI")]
    [Tooltip("Optional: worldspace or screen-space Text for displaying the player's name.")]
    [SerializeField] private Text nameText;

    [Tooltip("Optional: Text for displaying tap count.")]
    [SerializeField] private Text tapsText;

    [Header("Optional Feedback")]
    [Tooltip("Optional: scale punch when a tap is received.")]
    [SerializeField] private bool punchOnTap = true;

    [Tooltip("Punch scale amount (added to 1.0).")]
    [SerializeField] private float punchScale = 0.06f;

    [Tooltip("How fast the punch returns to normal.")]
    [SerializeField] private float punchReturnSpeed = 12f;

    private Vector3 _baseScale;
    private float _punchT = 0f;

    public string UID => uid;
    public string Username => username;
    public int TeamIndex => teamIndex;
    public int TotalTaps => totalTaps;

    private void Awake()
    {
        _baseScale = transform.localScale;
        RefreshUI();
    }

    private void Update()
    {
        if (!punchOnTap) return;

        if (_punchT > 0f)
        {
            _punchT = Mathf.MoveTowards(_punchT, 0f, Time.deltaTime * punchReturnSpeed);
            float k = _punchT;
            transform.localScale = _baseScale * (1f + (punchScale * k));
        }
        else
        {
            // ensure exact base
            if (transform.localScale != _baseScale)
                transform.localScale = _baseScale;
        }
    }

    /// <summary>
    /// Initialize/refresh identity data (called by PlayerSpawner).
    /// Safe to call multiple times (e.g., resume/re-attach).
    /// </summary>
    public void Init(string newUid, string newUsername, int newTeamIndex)
    {
        uid = newUid ?? "";
        username = (newUsername ?? "").Trim();
        teamIndex = newTeamIndex;

        // Keep taps as-is on re-init unless uid changes
        RefreshUI();
    }

    /// <summary>
    /// Add a tap delta to this player.
    /// Usually called when backend forwards a tap event.
    /// </summary>
    public void AddTaps(int delta)
    {
        delta = Mathf.Max(0, delta);
        lastTapDelta = delta;
        totalTaps += delta;

        if (punchOnTap && delta > 0)
        {
            _punchT = 1f;
        }

        RefreshUI();
    }

    /// <summary>
    /// Set total taps (useful if backend sends absolute count).
    /// </summary>
    public void SetTotalTaps(int absoluteTotal)
    {
        absoluteTotal = Mathf.Max(0, absoluteTotal);
        lastTapDelta = Mathf.Max(0, absoluteTotal - totalTaps);
        totalTaps = absoluteTotal;

        if (punchOnTap && lastTapDelta > 0)
        {
            _punchT = 1f;
        }

        RefreshUI();
    }

    public void AssignNameText(Text t)
    {
        nameText = t;
        RefreshUI();
    }

    public void AssignTapsText(Text t)
    {
        tapsText = t;
        RefreshUI();
    }

    private void RefreshUI()
    {
        if (nameText)
        {
            // Example: "Anna (A)" or "Ben (B)"
            string teamLabel = (teamIndex == 0) ? "A" : "B";
            nameText.text = $"{username} ({teamLabel})";
        }

        if (tapsText)
        {
            tapsText.text = totalTaps.ToString();
        }
    }
}
