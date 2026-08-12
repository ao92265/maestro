//! Samurai supervisor configuration (issue #45; `docs/samurai/prd.md` §7).
//!
//! Every threshold is configurable because **low thresholds ARE the test
//! mode** (PRD decision #7): set the park threshold to 2% and a real
//! park cycle runs in minutes — no simulation machinery exists.
//!
//! Persistence follows the existing app-data settings pattern
//! (`tauri_plugin_store`, like `commands/marketplace.rs`): the command layer
//! stores this struct as JSON under the `config` key of
//! `samurai-config.json`. This module stays tauri-free so defaults,
//! validation and the (de)serialization shape are unit-testable.
//!
//! Field notes:
//! - Durations carry explicit `_secs` suffixes (the issue text says
//!   `ack_timeout` / `staleness_window`; unitless duration fields are a
//!   footgun, so the unit is in the name).
//! - `staleness_window_secs` is consumed by the silent-death watchdog
//!   (`core/samurai_watchdog.rs`), which reads it once per tick.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};

/// Shared, live-updatable handle to the current config. Managed as tauri
/// state and read by the allowance evaluation loop each tick, so a settings
/// change applies on the next tick without a restart.
pub type SharedSamuraiConfig = Arc<RwLock<SamuraiConfig>>;

/// All Samurai thresholds (PRD §7). Serialized in snake_case — the same
/// spelling the issue, the PRD table and the audit rows use — both into the
/// settings store and over IPC to the frontend.
///
/// `#[serde(default)]` per container: a partial or older stored JSON
/// deserializes with PRD defaults for every missing field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SamuraiConfig {
    /// Handoff trigger: orchestrator context % that requests a handoff.
    pub handoff_context_pct: f64,
    /// Park soft threshold on the 5-hour window: stop spawning new
    /// subagents, wind down (PRD §5.5 — parking itself costs turns).
    pub park_soft_5h_pct: f64,
    /// Park hard threshold on the 5-hour window: park sequentially.
    pub park_hard_5h_pct: f64,
    /// Park hard threshold on the 7-day window.
    pub park_hard_7d_pct: f64,
    /// How long to wait for an injected instruction's ACK before the single
    /// retry → ALERT (PRD §5.3 "few minutes").
    pub ack_timeout_secs: u64,
    /// How long an instruction may wait for the agent's turn to END before it
    /// is alerted as stuck. Sized for the gap between Stop hooks, NOT for a
    /// reply: an orchestrator running a subagent wave plus a full build+test
    /// legitimately goes far longer than `ack_timeout_secs` without a single
    /// idle signal, and the ACK window used to double as this cap — so a
    /// long turn raised a false `never_idled` ALERT. The instruction is now
    /// KEPT past this alert and still delivered on the eventual Stop.
    pub max_turn_wait_secs: u64,
    /// Transcript-staleness window for the silent-death watchdog (issue #44).
    pub staleness_window_secs: u64,
    /// How long handoff files are kept after an epic completes — i.e. after
    /// its run config is ARCHIVED (PRD §8 row 1). Consumed by
    /// `core::samurai_files::sweep_handoff_retention`, run once per app
    /// start.
    pub handoff_retention_days: u32,
    /// Circuit breaker (issue #57, PRD §5.7): this many consecutive samurai
    /// audit events for one epic with repo HEAD unchanged trip the breaker —
    /// the epic's WORKING session is parked with an ALERT instead of burning
    /// the allowance. Progress signal is commits only in v1 (no `gh`
    /// issue-update polling); see `core/samurai_progress.rs`.
    pub breaker_events: u32,
    /// Second Brain size warning (issue #65; PRD §5.10/§5.11/§8): a Files
    /// inventory entry at or above this many bytes gets a size warning in
    /// the panel (the audit log is the canonical case — it only shrinks when
    /// the user clears it). A low value doubles as the test mode (PRD §7).
    pub size_warn_bytes: u64,
}

impl Default for SamuraiConfig {
    fn default() -> Self {
        Self {
            handoff_context_pct: 40.0,
            park_soft_5h_pct: 78.0,
            park_hard_5h_pct: 90.0,
            park_hard_7d_pct: 95.0,
            ack_timeout_secs: 180,
            // 30 min: longer than a subagent wave plus a full build+test
            // turn on a workspace this size, short enough that a genuinely
            // wedged turn still surfaces within one working session.
            max_turn_wait_secs: 1800,
            // Matches `samurai_watchdog::TRANSCRIPT_STALE_AFTER`, the window
            // this field now drives — the shipped behaviour, unchanged.
            staleness_window_secs: 120,
            handoff_retention_days: 14,
            breaker_events: 5,
            size_warn_bytes: 5 * 1024 * 1024,
        }
    }
}

impl SamuraiConfig {
    /// Sanity-checks a config before it is persisted or applied.
    ///
    /// Deliberately minimal: percentages must be real values in 0–100 and
    /// the timing windows non-zero. No `soft < hard` ordering is enforced —
    /// low/odd threshold combinations are exactly how the user tests live
    /// (PRD decision #7).
    pub fn validate(&self) -> Result<(), String> {
        let pcts = [
            ("handoff_context_pct", self.handoff_context_pct),
            ("park_soft_5h_pct", self.park_soft_5h_pct),
            ("park_hard_5h_pct", self.park_hard_5h_pct),
            ("park_hard_7d_pct", self.park_hard_7d_pct),
        ];
        for (name, value) in pcts {
            // 0 is not a threshold: every predicate here is `percent >=
            // threshold`, so a 0 handoff trigger hands off on EVERY tick
            // (unbounded generation churn) and a 0 park threshold parks on
            // every tick. Same floor reasoning as `size_warn_bytes` below.
            // `value > 0.0` is already false for NaN and -inf.
            if !(value > 0.0 && value <= 100.0) {
                return Err(format!(
                    "{name} must be a percentage above 0 and at most 100"
                ));
            }
        }
        // Upper bound, not just a floor: the injector computes
        // `ack_timeout * 3` as a `Duration`, and `Duration * u32` panics on
        // overflow — an unbounded value would kill the injector loop (a bare
        // `loop { tick }` with no catch) for the rest of the process.
        if !(1..=86_400).contains(&self.ack_timeout_secs) {
            return Err("ack_timeout_secs must be between 1 and 86400".to_string());
        }
        // Same bounds and the same reason: it becomes a `Duration` the
        // injector compares against on every tick.
        if !(1..=86_400).contains(&self.max_turn_wait_secs) {
            return Err("max_turn_wait_secs must be between 1 and 86400".to_string());
        }
        if self.staleness_window_secs == 0 {
            return Err("staleness_window_secs must be at least 1".to_string());
        }
        if self.breaker_events == 0 {
            return Err("breaker_events must be at least 1".to_string());
        }
        // Floor, because this one DELETES: 0 would mean "sweep every
        // archived epic's handoffs on the next app start", and the settings
        // field yields 0 for an emptied box (`Number("") === 0`).
        if self.handoff_retention_days == 0 {
            return Err("handoff_retention_days must be at least 1".to_string());
        }
        // 1 byte is the legitimate floor: it warns on every non-empty file,
        // which is exactly the live test mode (PRD decision #7). 0 would
        // warn on files that cannot shrink further — meaningless.
        if self.size_warn_bytes == 0 {
            return Err("size_warn_bytes must be at least 1".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_prd_section_7() {
        let cfg = SamuraiConfig::default();
        assert_eq!(cfg.handoff_context_pct, 40.0);
        assert_eq!(cfg.park_soft_5h_pct, 78.0);
        assert_eq!(cfg.park_hard_5h_pct, 90.0);
        assert_eq!(cfg.park_hard_7d_pct, 95.0);
        assert_eq!(cfg.handoff_retention_days, 14);
        assert_eq!(cfg.breaker_events, 5);
        assert_eq!(cfg.size_warn_bytes, 5 * 1024 * 1024);
        // PRD gives "few minutes" / no number — but they must be non-zero.
        assert!(cfg.ack_timeout_secs > 0);
        // Pinned: this is the window the watchdog actually runs on, and it
        // must keep matching `samurai_watchdog::TRANSCRIPT_STALE_AFTER`.
        assert_eq!(cfg.staleness_window_secs, 120);
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn empty_json_deserializes_to_defaults() {
        // The store starts empty; an absent/empty value must mean "PRD
        // defaults", never zeros.
        let cfg: SamuraiConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg, SamuraiConfig::default());
    }

    #[test]
    fn partial_json_keeps_defaults_for_missing_fields() {
        // An older stored config (fewer fields) must load with defaults
        // filling the gaps — this is what makes the #44 merge trivial.
        let cfg: SamuraiConfig = serde_json::from_str(r#"{"park_hard_5h_pct": 2.0}"#).unwrap();
        assert_eq!(cfg.park_hard_5h_pct, 2.0);
        assert_eq!(cfg.handoff_context_pct, 40.0);
        assert_eq!(
            cfg.staleness_window_secs,
            SamuraiConfig::default().staleness_window_secs
        );
        // Issue #57: a store written before `breaker_events` existed must
        // still load, with the PRD default filling the gap.
        assert_eq!(cfg.breaker_events, 5);
        // Issue #65: same for a store written before `size_warn_bytes`.
        assert_eq!(cfg.size_warn_bytes, 5 * 1024 * 1024);
    }

    #[test]
    fn serde_roundtrip_preserves_every_field() {
        let cfg = SamuraiConfig {
            handoff_context_pct: 5.0,
            park_soft_5h_pct: 1.0,
            park_hard_5h_pct: 2.0,
            park_hard_7d_pct: 3.0,
            ack_timeout_secs: 60,
            max_turn_wait_secs: 900,
            staleness_window_secs: 120,
            handoff_retention_days: 7,
            breaker_events: 3,
            size_warn_bytes: 1024,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: SamuraiConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
        // The wire/store spelling is the issue's snake_case naming — the
        // frontend and issue #46 consume these exact keys.
        for key in [
            "handoff_context_pct",
            "park_soft_5h_pct",
            "park_hard_5h_pct",
            "park_hard_7d_pct",
            "ack_timeout_secs",
            "staleness_window_secs",
            "handoff_retention_days",
            "breaker_events",
            "size_warn_bytes",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "missing {key} in {json}"
            );
        }
    }

    #[test]
    fn validate_rejects_out_of_range_values() {
        // One out-of-range field at a time, every other field left at its
        // PRD §7 default, so each assertion names exactly one rejection.
        for cfg in [
            SamuraiConfig {
                park_hard_5h_pct: 101.0,
                ..Default::default()
            },
            SamuraiConfig {
                handoff_context_pct: -1.0,
                ..Default::default()
            },
            SamuraiConfig {
                park_soft_5h_pct: f64::NAN,
                ..Default::default()
            },
            SamuraiConfig {
                ack_timeout_secs: 0,
                ..Default::default()
            },
            SamuraiConfig {
                staleness_window_secs: 0,
                ..Default::default()
            },
            SamuraiConfig {
                breaker_events: 0,
                ..Default::default()
            },
            // 0 now means "delete every archived epic's handoffs on the next
            // start" — the retention sweep consumes this field.
            SamuraiConfig {
                handoff_retention_days: 0,
                ..Default::default()
            },
            SamuraiConfig {
                size_warn_bytes: 0,
                ..Default::default()
            },
        ] {
            assert!(cfg.validate().is_err(), "should reject: {cfg:?}");
        }

        // Upper bound: the injector multiplies this Duration by 3, and
        // `Duration * u32` panics on overflow — an unbounded value would
        // kill the injector task permanently.
        let mut cfg = SamuraiConfig {
            ack_timeout_secs: u64::MAX,
            ..Default::default()
        };
        assert!(cfg.validate().is_err());
        cfg.ack_timeout_secs = 86_401;
        assert!(cfg.validate().is_err());
        cfg.ack_timeout_secs = 86_400;
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn validate_rejects_zero_percentages() {
        // 0 is not a threshold: `percent >= 0.0` holds for every reading, so
        // a 0 handoff trigger hands off on every tick (unbounded generation
        // churn) and a 0 park threshold parks on every tick. Reachable from
        // the settings modal — clearing the field yields `Number("") === 0`.
        for zero in [
            SamuraiConfig {
                handoff_context_pct: 0.0,
                ..SamuraiConfig::default()
            },
            SamuraiConfig {
                park_soft_5h_pct: 0.0,
                ..SamuraiConfig::default()
            },
            SamuraiConfig {
                park_hard_5h_pct: 0.0,
                ..SamuraiConfig::default()
            },
            SamuraiConfig {
                park_hard_7d_pct: 0.0,
                ..SamuraiConfig::default()
            },
        ] {
            assert!(zero.validate().is_err(), "{zero:?} must be rejected");
        }
        // The smallest legitimate test-mode threshold still passes.
        let cfg = SamuraiConfig {
            handoff_context_pct: 0.1,
            ..SamuraiConfig::default()
        };
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn validate_accepts_test_mode_thresholds() {
        // PRD decision #7: absurdly low thresholds are the supported way to
        // test live. They must not be "corrected".
        let cfg = SamuraiConfig {
            handoff_context_pct: 5.0,
            park_soft_5h_pct: 1.0,
            park_hard_5h_pct: 2.0,
            park_hard_7d_pct: 2.0,
            ..SamuraiConfig::default()
        };
        assert!(cfg.validate().is_ok());
    }
}
