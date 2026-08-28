/*!
Health of the other systems on this machine.

Maestro's existing health checker only looks at Maestro's own memory files and
a dev-process watchlist. Nothing told Alex whether ACT, Atelier, Vanguard or
the Codor bus were up, which is what Rohcna's health strip was for.

Two rules are carried over from Rohcna, both of which cost a rewrite to learn:

- A down tile says what the state MEANS. A truncated connection error defeats
  the glance the tile exists for.
- A launchd job with a live process is healthy whatever its last exit code
  says. That column is the PREVIOUS run's exit, so any restart leaves a daemon
  showing the signal that killed it while it serves perfectly. Reading that as
  failing flags the healthiest thing on the strip and teaches him to ignore it.
*/

use std::time::Duration;

use serde::Serialize;

const PROBE_TIMEOUT: Duration = Duration::from_millis(1200);

/// The listeners in the ecosystem's own port map. Ports are claimed there
/// first and bound second, so this list mirrors that file rather than
/// discovering anything.
const SERVICES: [(&str, u16); 7] = [
    ("ACT", 3847),
    ("ACT dashboard", 3848),
    ("Atelier", 3849),
    ("ACT worker", 3859),
    ("Rohcna", 4317),
    ("Codor bus", 8137),
    ("Vanguard", 8787),
];

/// The background jobs worth noticing when they stop.
const WATCHED_JOBS: [&str; 7] = [
    "com.nanoclaw",
    "com.nanoclaw.notes-sync",
    "app.codor.switchboard",
    "com.aoreilly.claude-standing-orders",
    "com.aoreilly.claude-run-referee",
    "com.aoreilly.claude-maintenance",
    "com.aoreilly.claude-checkpoint",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceTile {
    pub name: String,
    pub port: u16,
    pub up: bool,
    /// What the state means, in words. Never a raw socket error.
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRow {
    pub label: String,
    /// Why it is unhealthy, in words. Absent when it is fine.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsHealth {
    pub healthy: usize,
    pub total: usize,
    pub failing: Vec<JobRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EcosystemHealth {
    pub services: Vec<ServiceTile>,
    pub jobs: JobsHealth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchctlRow {
    pub pid: String,
    pub status: i64,
    pub label: String,
}

/// One row per loaded job: PID, status, label, tab separated. The PID is "-"
/// when the job is not currently up, and the status can be negative when a
/// signal killed it.
pub fn parse_launchctl(text: &str) -> Vec<LaunchctlRow> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() != 3 {
                return None;
            }
            let pid = fields[0].trim();
            let status = fields[1].trim().parse::<i64>().ok()?;
            let label = fields[2].trim();
            if pid.is_empty() || label.is_empty() || label.contains(char::is_whitespace) {
                return None;
            }
            Some(LaunchctlRow {
                pid: pid.to_string(),
                status,
                label: label.to_string(),
            })
        })
        .collect()
}

/// Live process: healthy, whatever the exit column says. No process: that
/// exit code is the only evidence there is. Missing from the listing at all:
/// failing, because a job he expects to see and does not is exactly the blind
/// spot this exists to catch.
pub fn jobs_health(text: &str, watched: &[&str]) -> JobsHealth {
    let rows = parse_launchctl(text);
    let mut healthy = 0;
    let mut failing = Vec::new();
    for label in watched {
        match rows.iter().find(|row| row.label == *label) {
            None => failing.push(JobRow {
                label: (*label).to_string(),
                reason: Some("not loaded".to_string()),
            }),
            Some(row) if row.pid != "-" => healthy += 1,
            Some(row) if row.status != 0 => failing.push(JobRow {
                label: (*label).to_string(),
                reason: Some(format!("last run stopped with {}", row.status)),
            }),
            Some(_) => healthy += 1,
        }
    }
    JobsHealth {
        healthy,
        total: watched.len(),
        failing,
    }
}

/// A refused or timed out connection is a normal down state, never an error.
async fn port_is_open(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

#[tauri::command]
pub async fn ecosystem_health() -> Result<EcosystemHealth, String> {
    let mut services = Vec::with_capacity(SERVICES.len());
    for (name, port) in SERVICES {
        let up = port_is_open(port).await;
        services.push(ServiceTile {
            name: name.to_string(),
            port,
            up,
            detail: if up {
                "Answering".to_string()
            } else {
                "Not running".to_string()
            },
        });
    }

    let listing = tokio::process::Command::new("/bin/launchctl")
        .arg("list")
        .output()
        .await
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default();

    Ok(EcosystemHealth {
        services,
        jobs: jobs_health(&listing, &WATCHED_JOBS),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = "PID\tStatus\tLabel\n\
        1234\t0\tcom.nanoclaw\n\
        -\t0\tcom.nanoclaw.notes-sync\n\
        4321\t-15\tapp.codor.switchboard\n\
        -\t23\tcom.aoreilly.claude-maintenance\n";

    #[test]
    fn the_header_line_is_not_a_job() {
        let rows = parse_launchctl(LISTING);
        assert_eq!(rows.len(), 4);
        assert!(rows.iter().all(|row| row.label != "Label"));
    }

    #[test]
    fn a_job_killed_by_a_signal_parses_its_negative_status() {
        let rows = parse_launchctl(LISTING);
        let codor = rows.iter().find(|r| r.label == "app.codor.switchboard").unwrap();
        assert_eq!(codor.status, -15);
    }

    /* The rule that cost a rewrite: a running daemon restarted with
       `kickstart -k` carries SIGTERM in the status column forever. Calling
       that failing flags the healthiest thing on the strip. */
    #[test]
    fn a_running_job_is_healthy_whatever_its_last_exit_says() {
        let health = jobs_health(LISTING, &["app.codor.switchboard"]);
        assert_eq!(health.healthy, 1);
        assert!(health.failing.is_empty());
    }

    #[test]
    fn a_stopped_job_that_exited_cleanly_is_healthy() {
        let health = jobs_health(LISTING, &["com.nanoclaw.notes-sync"]);
        assert_eq!(health.healthy, 1);
        assert!(health.failing.is_empty());
    }

    #[test]
    fn a_stopped_job_that_died_badly_is_failing_and_says_so() {
        let health = jobs_health(LISTING, &["com.aoreilly.claude-maintenance"]);
        assert_eq!(health.healthy, 0);
        assert_eq!(health.failing.len(), 1);
        assert_eq!(
            health.failing[0].reason.as_deref(),
            Some("last run stopped with 23")
        );
    }

    /* A job he expects and cannot see is the blind spot the strip exists for,
       so absence is louder than a bad exit code, not quieter. */
    #[test]
    fn a_job_that_is_not_loaded_at_all_is_failing() {
        let health = jobs_health(LISTING, &["com.aoreilly.claude-checkpoint"]);
        assert_eq!(health.failing[0].reason.as_deref(), Some("not loaded"));
    }

    #[test]
    fn the_counts_cover_every_watched_job() {
        let watched = ["com.nanoclaw", "com.aoreilly.claude-maintenance", "nope"];
        let health = jobs_health(LISTING, &watched);
        assert_eq!(health.total, 3);
        assert_eq!(health.healthy, 1);
        assert_eq!(health.failing.len(), 2);
    }

    #[test]
    fn junk_lines_are_ignored_rather_than_breaking_the_read() {
        let rows = parse_launchctl("garbage\n\n1\t2\n1\t0\tcom.example\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "com.example");
    }
}
