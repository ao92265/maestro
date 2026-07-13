//! Read/write management of Claude Code's real MCP configuration.
//!
//! Unlike `mcp_manager` (read-only discovery used at session launch), this
//! module edits the files Claude Code itself reads:
//! - Project scope: `<project>/.mcp.json` → `mcpServers`
//! - User scope:    `~/.claude.json` → top-level `mcpServers`
//! - Local scope:   `~/.claude.json` → `projects[<key>].mcpServers`
//!
//! Enable/disable piggybacks on Claude Code's own per-project lists in
//! `~/.claude.json` `projects[<key>]`:
//! - `.mcp.json` servers: `enabledMcpjsonServers` / `disabledMcpjsonServers`
//! - user/local servers and claude.ai connectors: `disabledMcpServers`
//!
//! claude.ai connectors (account-level, e.g. "claude.ai Atlassian") are not
//! defined in any local file; the names Claude Code has seen are cached in the
//! top-level `claudeAiMcpEverConnected` array, and per-project disabling works
//! through `disabledMcpServers` — so they can be listed and toggled, but not
//! added, edited or removed locally.
//!
//! Every write copies the target file to `<file>.maestro-backup` first and
//! only mutates the addressed subtree, leaving all other keys untouched.

use std::fs;
use std::path::{Path, PathBuf};

use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Scope of a managed MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    /// `<project>/.mcp.json`
    Project,
    /// `~/.claude.json` top-level `mcpServers`
    User,
    /// `~/.claude.json` `projects[<key>].mcpServers`
    Local,
    /// claude.ai account connector (toggle only)
    Connector,
}

/// A server as shown in the management UI, with its raw JSON config so any
/// transport type (stdio/http/sse/…) round-trips without loss.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpManagedServer {
    pub name: String,
    pub scope: McpScope,
    pub enabled: bool,
    /// "stdio" | "http" | "sse" | … (explicit `type` or inferred)
    pub transport: String,
    /// Raw entry from the config file, for display and editing.
    pub config: Value,
}

/// A claude.ai account connector (from `claudeAiMcpEverConnected`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnector {
    pub name: String,
    pub enabled: bool,
}

/// Everything the management UI needs, read fresh from disk (no cache).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatusView {
    pub servers: Vec<McpManagedServer>,
    pub connectors: Vec<McpConnector>,
}

/// Servers injected by Maestro itself for session status reporting.
/// Mirrors the naming used by `mcp_config_writer`.
pub fn is_internal_server(name: &str) -> bool {
    name == "maestro" || name == "maestro-status" || name.starts_with("maestro-")
}

fn claude_json_path() -> Result<PathBuf, String> {
    BaseDirs::new()
        .map(|d| d.home_dir().join(".claude.json"))
        .ok_or_else(|| "Cannot resolve home directory".to_string())
}

/// Converts a project path into the key format Claude Code uses in
/// `~/.claude.json` `projects`: forward slashes, no `\\?\` prefix.
pub fn claude_project_key(project_path: &str) -> String {
    let canonical = fs::canonicalize(project_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| project_path.to_string());
    let stripped = canonical
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{}", rest))
        .unwrap_or_else(|| {
            canonical
                .strip_prefix(r"\\?\")
                .unwrap_or(&canonical)
                .to_string()
        });
    stripped.replace('\\', "/")
}

/// Compares two project keys leniently: slash direction, trailing slash and
/// (on Windows) case differences must not cause a miss.
pub(crate) fn project_keys_match(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    let (a, b) = (norm(a), norm(b));
    if cfg!(windows) {
        a.eq_ignore_ascii_case(&b)
    } else {
        a == b
    }
}

/// Finds the existing key in `projects` matching this project, if any.
fn find_project_key(projects: &Map<String, Value>, project_key: &str) -> Option<String> {
    projects
        .keys()
        .find(|k| project_keys_match(k, project_key))
        .cloned()
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {:?}: {}", path, e))?;
    if content.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {:?}: {}", path, e))
}

/// Writes `value` to `path`, backing up the existing file to
/// `<file>.maestro-backup` and using a temp-file + rename so a crash can't
/// leave a truncated config behind.
fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if path.exists() {
        let backup = path.with_extension(match path.extension().and_then(|e| e.to_str()) {
            Some(ext) => format!("{}.maestro-backup", ext),
            None => "maestro-backup".to_string(),
        });
        fs::copy(path, &backup)
            .map_err(|e| format!("Failed to back up {:?} to {:?}: {}", path, backup, e))?;
    }

    let pretty = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize JSON for {:?}: {}", path, e))?;

    let tmp = path.with_extension("maestro-tmp");
    fs::write(&tmp, pretty).map_err(|e| format!("Failed to write {:?}: {}", tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| format!("Failed to replace {:?}: {}", path, e))
}

/// Infers the transport label from a raw server entry.
fn transport_of(config: &Value) -> String {
    if let Some(t) = config.get("type").and_then(|v| v.as_str()) {
        return t.to_string();
    }
    if config.get("url").is_some() {
        return "http".to_string();
    }
    "stdio".to_string()
}

/// Returns the string items of `projects[<key>].<list>` (empty if absent).
fn project_list(project_entry: Option<&Value>, list: &str) -> Vec<String> {
    project_entry
        .and_then(|p| p.get(list))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Reads the full management view for a project, fresh from disk.
pub fn get_status(project_path: &str) -> Result<McpStatusView, String> {
    let project_key = claude_project_key(project_path);
    let claude_root = read_json_file(&claude_json_path()?)?;

    let empty_map = Map::new();
    let projects = claude_root
        .get("projects")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty_map);
    let project_entry = find_project_key(projects, &project_key)
        .and_then(|k| projects.get(&k));

    let disabled_mcpjson = project_list(project_entry, "disabledMcpjsonServers");
    let disabled_mcp = project_list(project_entry, "disabledMcpServers");

    let mut servers = Vec::new();

    // Project scope: <project>/.mcp.json
    let mcp_json = read_json_file(&Path::new(project_path).join(".mcp.json"))?;
    if let Some(entries) = mcp_json.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, config) in entries {
            if is_internal_server(name) {
                continue;
            }
            servers.push(McpManagedServer {
                name: name.clone(),
                scope: McpScope::Project,
                enabled: !disabled_mcpjson.contains(name),
                transport: transport_of(config),
                config: config.clone(),
            });
        }
    }

    // Local scope: ~/.claude.json projects[<key>].mcpServers
    if let Some(entries) = project_entry
        .and_then(|p| p.get("mcpServers"))
        .and_then(|v| v.as_object())
    {
        for (name, config) in entries {
            servers.push(McpManagedServer {
                name: name.clone(),
                scope: McpScope::Local,
                enabled: !disabled_mcp.contains(name),
                transport: transport_of(config),
                config: config.clone(),
            });
        }
    }

    // User scope: ~/.claude.json top-level mcpServers
    if let Some(entries) = claude_root.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, config) in entries {
            servers.push(McpManagedServer {
                name: name.clone(),
                scope: McpScope::User,
                enabled: !disabled_mcp.contains(name),
                transport: transport_of(config),
                config: config.clone(),
            });
        }
    }

    // claude.ai connectors: names cached in claudeAiMcpEverConnected
    let connectors = claude_root
        .get("claudeAiMcpEverConnected")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|name| McpConnector {
                    name: name.to_string(),
                    enabled: !disabled_mcp.iter().any(|d| d == name),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(McpStatusView { servers, connectors })
}

/// Adds or replaces a server entry in the file for the given scope.
pub fn upsert_server(
    project_path: &str,
    scope: McpScope,
    name: &str,
    config: Value,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Server name cannot be empty".to_string());
    }
    if is_internal_server(name) {
        return Err(format!(
            "'{}' is reserved for Maestro's internal status server",
            name
        ));
    }
    if !config.is_object() {
        return Err("Server config must be a JSON object".to_string());
    }

    match scope {
        McpScope::Project => {
            let path = Path::new(project_path).join(".mcp.json");
            let mut root = read_json_file(&path)?;
            ensure_object(&mut root, "mcpServers")?
                .insert(name.to_string(), config);
            write_json_file(&path, &root)
        }
        McpScope::User => {
            let path = claude_json_path()?;
            let mut root = read_json_file(&path)?;
            ensure_object(&mut root, "mcpServers")?
                .insert(name.to_string(), config);
            write_json_file(&path, &root)
        }
        McpScope::Local => {
            let path = claude_json_path()?;
            let mut root = read_json_file(&path)?;
            let entry = ensure_project_entry(&mut root, project_path)?;
            ensure_object(entry, "mcpServers")?
                .insert(name.to_string(), config);
            write_json_file(&path, &root)
        }
        McpScope::Connector => Err(
            "claude.ai connectors are managed by your claude.ai account and cannot be edited here"
                .to_string(),
        ),
    }
}

/// Removes a server entry from the file for the given scope, and cleans its
/// name out of the project's enable/disable lists.
pub fn remove_server(project_path: &str, scope: McpScope, name: &str) -> Result<(), String> {
    if is_internal_server(name) {
        return Err(format!("'{}' is managed by Maestro and cannot be removed", name));
    }

    match scope {
        McpScope::Project => {
            let path = Path::new(project_path).join(".mcp.json");
            let mut root = read_json_file(&path)?;
            let removed = root
                .get_mut("mcpServers")
                .and_then(|v| v.as_object_mut())
                .map(|m| m.remove(name).is_some())
                .unwrap_or(false);
            if !removed {
                return Err(format!("Server '{}' not found in .mcp.json", name));
            }
            write_json_file(&path, &root)?;
            // Best-effort cleanup of stale approve/deny list entries.
            let _ = prune_from_lists(project_path, name);
            Ok(())
        }
        McpScope::User => {
            let path = claude_json_path()?;
            let mut root = read_json_file(&path)?;
            let removed = root
                .get_mut("mcpServers")
                .and_then(|v| v.as_object_mut())
                .map(|m| m.remove(name).is_some())
                .unwrap_or(false);
            if !removed {
                return Err(format!("Server '{}' not found in ~/.claude.json", name));
            }
            write_json_file(&path, &root)
        }
        McpScope::Local => {
            let path = claude_json_path()?;
            let mut root = read_json_file(&path)?;
            let entry = ensure_project_entry(&mut root, project_path)?;
            let removed = entry
                .get_mut("mcpServers")
                .and_then(|v| v.as_object_mut())
                .map(|m| m.remove(name).is_some())
                .unwrap_or(false);
            if !removed {
                return Err(format!(
                    "Server '{}' not found in local scope for this project",
                    name
                ));
            }
            write_json_file(&path, &root)
        }
        McpScope::Connector => Err(
            "claude.ai connectors are managed by your claude.ai account and cannot be removed here"
                .to_string(),
        ),
    }
}

/// Enables or disables a server for this project using Claude Code's own
/// per-project lists in ~/.claude.json.
pub fn set_server_enabled(
    project_path: &str,
    scope: McpScope,
    name: &str,
    enabled: bool,
) -> Result<(), String> {
    if is_internal_server(name) {
        return Err(format!("'{}' is managed by Maestro and cannot be toggled", name));
    }

    let path = claude_json_path()?;
    let mut root = read_json_file(&path)?;
    let entry = ensure_project_entry(&mut root, project_path)?;

    match scope {
        McpScope::Project => {
            // Claude Code semantics for .mcp.json servers: approved names live in
            // enabledMcpjsonServers, rejected ones in disabledMcpjsonServers.
            if enabled {
                list_remove(entry, "disabledMcpjsonServers", name);
                list_add(entry, "enabledMcpjsonServers", name);
            } else {
                list_remove(entry, "enabledMcpjsonServers", name);
                list_add(entry, "disabledMcpjsonServers", name);
            }
        }
        McpScope::User | McpScope::Local | McpScope::Connector => {
            if enabled {
                list_remove(entry, "disabledMcpServers", name);
            } else {
                list_add(entry, "disabledMcpServers", name);
            }
        }
    }

    write_json_file(&path, &root)
}

/// Removes `name` from both mcpjson approve/deny lists (used after deleting a
/// project-scope server).
fn prune_from_lists(project_path: &str, name: &str) -> Result<(), String> {
    let path = claude_json_path()?;
    let mut root = read_json_file(&path)?;
    let project_key = claude_project_key(project_path);

    let Some(projects) = root.get_mut("projects").and_then(|v| v.as_object_mut()) else {
        return Ok(());
    };
    let Some(key) = find_project_key(projects, &project_key) else {
        return Ok(());
    };
    let Some(entry) = projects.get_mut(&key) else {
        return Ok(());
    };

    let before = (
        project_list(Some(entry), "enabledMcpjsonServers"),
        project_list(Some(entry), "disabledMcpjsonServers"),
    );
    list_remove(entry, "enabledMcpjsonServers", name);
    list_remove(entry, "disabledMcpjsonServers", name);
    let after = (
        project_list(Some(entry), "enabledMcpjsonServers"),
        project_list(Some(entry), "disabledMcpjsonServers"),
    );

    if before != after {
        write_json_file(&path, &root)?;
    }
    Ok(())
}

/// Gets `root[key]` as a mutable object, creating an empty one if absent.
fn ensure_object<'a>(root: &'a mut Value, key: &str) -> Result<&'a mut Map<String, Value>, String> {
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "Config root is not a JSON object".to_string())?;
    if !obj.get(key).map(|v| v.is_object()).unwrap_or(false) {
        obj.insert(key.to_string(), json!({}));
    }
    Ok(obj
        .get_mut(key)
        .and_then(|v| v.as_object_mut())
        .expect("just inserted object"))
}

/// Gets the mutable `projects[<key>]` entry for this project in ~/.claude.json,
/// creating a minimal one (Claude Code fills in the rest lazily) if absent.
fn ensure_project_entry<'a>(
    root: &'a mut Value,
    project_path: &str,
) -> Result<&'a mut Value, String> {
    let project_key = claude_project_key(project_path);
    let projects = ensure_object(root, "projects")?;
    let key = find_project_key(projects, &project_key).unwrap_or(project_key);
    if !projects.get(&key).map(|v| v.is_object()).unwrap_or(false) {
        projects.insert(key.clone(), json!({}));
    }
    Ok(projects.get_mut(&key).expect("just inserted project entry"))
}

/// Adds `name` to the string array `entry[list]` if not present (creates the array).
fn list_add(entry: &mut Value, list: &str, name: &str) {
    let Some(obj) = entry.as_object_mut() else { return };
    if !obj.get(list).map(|v| v.is_array()).unwrap_or(false) {
        obj.insert(list.to_string(), json!([]));
    }
    let arr = obj.get_mut(list).and_then(|v| v.as_array_mut()).unwrap();
    if !arr.iter().any(|v| v.as_str() == Some(name)) {
        arr.push(json!(name));
    }
}

/// Removes `name` from the string array `entry[list]` if present.
fn list_remove(entry: &mut Value, list: &str, name: &str) {
    if let Some(arr) = entry
        .as_object_mut()
        .and_then(|o| o.get_mut(list))
        .and_then(|v| v.as_array_mut())
    {
        arr.retain(|v| v.as_str() != Some(name));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_claude_project_key_normalizes_backslashes() {
        // Non-existent path: canonicalize fails, falls back to raw input.
        assert_eq!(
            claude_project_key(r"D:\nonexistent\proj"),
            "D:/nonexistent/proj"
        );
    }

    #[test]
    fn test_project_keys_match_lenient() {
        assert!(project_keys_match("C:/git/maestro", r"C:\git\maestro"));
        assert!(project_keys_match("C:/git/maestro/", "C:/git/maestro"));
        #[cfg(windows)]
        assert!(project_keys_match("c:/git/maestro", "C:/git/maestro"));
        assert!(!project_keys_match("C:/git/other", "C:/git/maestro"));
    }

    #[test]
    fn test_is_internal_server() {
        assert!(is_internal_server("maestro"));
        assert!(is_internal_server("maestro-status"));
        assert!(is_internal_server("maestro-status-3"));
        assert!(!is_internal_server("playwright"));
    }

    #[test]
    fn test_transport_inference() {
        assert_eq!(transport_of(&json!({"type": "sse", "url": "x"})), "sse");
        assert_eq!(transport_of(&json!({"url": "http://x"})), "http");
        assert_eq!(transport_of(&json!({"command": "npx"})), "stdio");
    }

    #[test]
    fn test_list_add_remove() {
        let mut entry = json!({});
        list_add(&mut entry, "disabledMcpServers", "foo");
        list_add(&mut entry, "disabledMcpServers", "foo");
        assert_eq!(entry["disabledMcpServers"], json!(["foo"]));
        list_remove(&mut entry, "disabledMcpServers", "foo");
        assert_eq!(entry["disabledMcpServers"], json!([]));
    }

    #[test]
    fn test_upsert_and_remove_project_scope() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().into_owned();

        upsert_server(
            &project,
            McpScope::Project,
            "test-server",
            json!({"type": "stdio", "command": "npx", "args": ["-y", "pkg"]}),
        )
        .unwrap();

        let written = read_json_file(&dir.path().join(".mcp.json")).unwrap();
        assert_eq!(written["mcpServers"]["test-server"]["command"], "npx");

        // Upsert preserves sibling entries (e.g. Maestro's injected server).
        upsert_server(
            &project,
            McpScope::Project,
            "second",
            json!({"type": "http", "url": "http://localhost:1"}),
        )
        .unwrap();
        let written = read_json_file(&dir.path().join(".mcp.json")).unwrap();
        assert!(written["mcpServers"]["test-server"].is_object());

        // Backup exists after the second write.
        assert!(dir.path().join(".mcp.maestro-backup").exists()
            || dir.path().join(".mcp.json.maestro-backup").exists());

        remove_server(&project, McpScope::Project, "test-server").unwrap();
        let written = read_json_file(&dir.path().join(".mcp.json")).unwrap();
        assert!(written["mcpServers"]["test-server"].is_null());
        assert!(written["mcpServers"]["second"].is_object());
    }

    /// Read-only smoke test against the developer's real config files.
    /// Ignored by default: only meaningful on a machine with Claude Code set up.
    #[test]
    #[ignore]
    fn smoke_get_status_real_files() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let status = get_status(&repo_root).unwrap();
        println!("servers:");
        for s in &status.servers {
            println!("  [{:?}] {} ({}) enabled={}", s.scope, s.name, s.transport, s.enabled);
        }
        println!("connectors:");
        for c in &status.connectors {
            println!("  {} enabled={}", c.name, c.enabled);
        }
    }

    #[test]
    fn test_upsert_rejects_internal_names() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().to_string_lossy().into_owned();
        let err = upsert_server(&project, McpScope::Project, "maestro-status", json!({}));
        assert!(err.is_err());
    }
}
