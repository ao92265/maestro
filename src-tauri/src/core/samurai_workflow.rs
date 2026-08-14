//! Samurai run workflow graph (issue #91): the editable process every
//! orchestrator brief carries as its numbered WORKFLOW section.
//!
//! The graph is INSTRUCTION, not machinery — v1 has no Maestro-side step
//! enforcement. Maestro compiles the path reachable from the start node
//! into a numbered step list; `samurai_prompts` embeds that list in the
//! gen-1 opening brief and in every successor/recovery brief, so the
//! workflow survives handoffs (the launch snapshots the graph into the run
//! config — `samurai_run_config::SamuraiRunConfig::workflow` — and
//! successor briefs recompile from that snapshot, never from a default
//! that may have changed since).
//!
//! The serde types are the wire format the React Flow editor sends through
//! `samurai_launch_run` and receives from `samurai_default_workflow`
//! (`src/lib/samurai.ts` mirrors them).
//!
//! **Compile walk rule** (deterministic by construction): start at
//! [`WorkflowGraph::start`]; at each node follow the FIRST outgoing edge in
//! the graph's edge-list order (so a branch — multiple outgoing edges —
//! resolves to the earliest-listed one); the walk stops at a node with no
//! outgoing edge, at an edge whose target names no node, or when it would
//! revisit a node (cycle guard). Nodes the walk never reaches are excluded
//! from the compiled text. Node text is whitespace-normalized — briefs are
//! single paste-able lines (`samurai_prompts` module doc) and node text is
//! UI-editable, so a newline typed into the editor must never smuggle an
//! early submit into the terminal; a node whose text normalizes to empty
//! contributes no step (the walk still continues through it).

use serde::{Deserialize, Serialize};

/// One workflow step box. `id` is the stable identity edits preserve —
/// renumbering happens at compile time, never on the node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowNode {
    pub id: String,
    /// The step's instruction text, editable in the UI. Compiled with
    /// whitespace collapsed (see module doc).
    pub text: String,
}

/// One directed edge between two node ids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowEdge {
    pub from: String,
    pub to: String,
}

/// The whole graph — the wire format the UI sends. `Default` is the
/// canonical sequential batch workflow (issue #91 Part A), which is also
/// what a launch without an explicit graph runs with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowGraph {
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    /// Node id the compile walk starts from.
    pub start: String,
}

impl Default for WorkflowGraph {
    /// The canonical DEFAULT workflow: strictly one issue at a time —
    /// implement → fresh-eyes review → committed QA report → push — then
    /// the batch phase: whole-branch review → batch QA from the committed
    /// reports → the PR readied for the HUMAN merge decision. One node per
    /// step, a linear chain. Node texts deliberately avoid the word "epic"
    /// (the #87 contract: briefs for comma-separated issue lists must stay
    /// epic-free) and never restate marker strings.
    fn default() -> Self {
        let steps: [(&str, &str); 7] = [
            (
                "implement",
                "Work the run's issues strictly ONE at a time, in the established order. \
                 For the CURRENT issue: implement it via SMALL idempotent subagent steps, \
                 each committing its completed step to this branch.",
            ),
            (
                "review",
                "Run a fresh-eyes review of that issue's full diff and fix what it finds.",
            ),
            (
                "qa-report",
                "Write a QA report for that issue and COMMIT it to this branch as \
                 docs/qa/<batch>/issue-<n>.md — the batch QA step later uses these \
                 committed reports as its checklist.",
            ),
            (
                "push",
                "Push the branch. Only then take up the NEXT issue and work it through \
                 these same per-issue steps.",
            ),
            (
                "batch-review",
                "After ALL issues are done: review the branch as a whole — the full \
                 combined diff — for cross-issue defects no per-issue review can see.",
            ),
            (
                "batch-qa",
                "Run a batch QA pass using the committed per-issue QA reports as its \
                 checklist.",
            ),
            (
                "batch-pr",
                "Open or finalize the run's pull request so it is ready for the HUMAN \
                 merge decision — NEVER merge it yourself.",
            ),
        ];
        let nodes = steps
            .iter()
            .map(|(id, text)| WorkflowNode {
                id: (*id).to_string(),
                text: (*text).to_string(),
            })
            .collect();
        let edges = steps
            .windows(2)
            .map(|pair| WorkflowEdge {
                from: pair[0].0.to_string(),
                to: pair[1].0.to_string(),
            })
            .collect();
        Self {
            nodes,
            edges,
            start: steps[0].0.to_string(),
        }
    }
}

/// Serializes the path reachable from the start node into the numbered
/// step list (`Step 1: … Step 2: …`) the briefs embed. Single line by
/// construction; the walk rule is documented on the module. An empty walk
/// (start names no node, or every reached node has empty text) compiles to
/// an empty string — the brief then simply carries no WORKFLOW section.
pub fn compile(graph: &WorkflowGraph) -> String {
    let mut visited: Vec<&str> = Vec::new();
    let mut steps: Vec<String> = Vec::new();
    let mut current = graph.start.as_str();
    loop {
        // An edge target (or the start) naming no node ends the walk.
        let Some(node) = graph.nodes.iter().find(|n| n.id == current) else {
            break;
        };
        // Cycle guard: stop before revisiting a node.
        if visited.contains(&current) {
            break;
        }
        visited.push(current);
        let text = node.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            steps.push(text);
        }
        // Follow the FIRST outgoing edge in edge-list order.
        let Some(edge) = graph.edges.iter().find(|e| e.from == current) else {
            break;
        };
        current = edge.to.as_str();
    }
    steps
        .iter()
        .enumerate()
        .map(|(i, text)| format!("Step {}: {text}", i + 1))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The compiled workflow for a run: the graph its config snapshotted at
/// launch, or the default template when the config predates workflows
/// (backward compat — issue #91) or no config exists at all.
pub fn compiled_for_run(stored: Option<&WorkflowGraph>) -> String {
    match stored {
        Some(graph) => compile(graph),
        None => compile(&WorkflowGraph::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_graph_compiles_to_the_canonical_workflow() {
        // Issue #91 acceptance: implement → review → committed QA report →
        // push per issue, then batch review → batch QA from the reports →
        // PR readied for the HUMAN merge decision — numbered, in order.
        let text = compile(&WorkflowGraph::default());
        for (step, marker) in [
            (1, "ONE at a time"),
            (1, "SMALL idempotent subagent steps"),
            (2, "fresh-eyes review"),
            (3, "QA report"),
            (
                3,
                "COMMIT it to this branch as docs/qa/<batch>/issue-<n>.md",
            ),
            (4, "Push the branch"),
            (4, "NEXT issue"),
            (5, "cross-issue defects"),
            (6, "batch QA pass using the committed per-issue QA reports"),
            (7, "HUMAN merge decision"),
            (7, "NEVER merge it yourself"),
        ] {
            let step_start = text
                .find(&format!("Step {step}: "))
                .unwrap_or_else(|| panic!("missing Step {step} in {text}"));
            let step_end = text
                .find(&format!("Step {}: ", step + 1))
                .unwrap_or(text.len());
            assert!(
                text[step_start..step_end].contains(marker),
                "Step {step} must contain {marker:?}: {text}"
            );
        }
        // All seven steps, numbered contiguously, in one line.
        assert!(text.contains("Step 7: "));
        assert!(!text.contains("Step 8: "));
        assert!(!text.contains('\n'));
        // The #87 contract: node texts stay epic-free.
        assert!(!text.to_lowercase().contains("epic"));
    }

    #[test]
    fn test_default_graph_shape_is_a_linear_chain() {
        let graph = WorkflowGraph::default();
        assert_eq!(graph.nodes.len(), 7);
        assert_eq!(graph.edges.len(), 6);
        assert_eq!(graph.start, "implement");
        // Every node id is unique and every edge joins adjacent nodes.
        let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
        for (i, edge) in graph.edges.iter().enumerate() {
            assert_eq!(edge.from, ids[i]);
            assert_eq!(edge.to, ids[i + 1]);
        }
    }

    #[test]
    fn test_editing_a_node_text_changes_the_compiled_line() {
        let mut graph = WorkflowGraph::default();
        graph
            .nodes
            .iter_mut()
            .find(|n| n.id == "review")
            .unwrap()
            .text = "Custom review ritual".to_string();
        let text = compile(&graph);
        assert!(text.contains("Step 2: Custom review ritual"), "{text}");
        assert!(!text.contains("fresh-eyes review"), "{text}");
        // Neighbours keep their numbers — only the edited line changed.
        assert!(text.contains("Step 1: Work the run's issues"), "{text}");
        assert!(text.contains("Step 3: Write a QA report"), "{text}");
    }

    #[test]
    fn test_removing_the_qa_report_node_removes_its_step_and_renumbers() {
        // Issue #91 acceptance: no QA-report node → no QA-report step. The
        // UI rewires review → push when deleting the box; later steps
        // renumber down.
        let mut graph = WorkflowGraph::default();
        graph.nodes.retain(|n| n.id != "qa-report");
        graph
            .edges
            .retain(|e| e.from != "qa-report" && e.to != "qa-report");
        graph.edges.push(WorkflowEdge {
            from: "review".to_string(),
            to: "push".to_string(),
        });
        let text = compile(&graph);
        assert!(!text.contains("QA report for that issue"), "{text}");
        assert!(text.contains("Step 3: Push the branch"), "{text}");
        assert!(text.contains("Step 6: "), "{text}");
        assert!(!text.contains("Step 7: "), "{text}");
    }

    #[test]
    fn test_unreachable_nodes_are_excluded() {
        // A node nothing connects to from the start never compiles — and a
        // dangling edge from it changes nothing.
        let mut graph = WorkflowGraph::default();
        graph.nodes.push(WorkflowNode {
            id: "island".to_string(),
            text: "Unreachable island step".to_string(),
        });
        let text = compile(&graph);
        assert!(!text.contains("island"), "{text}");
        assert!(text.contains("Step 7: "), "the chain itself is intact");

        // Severing the chain after review makes everything downstream
        // unreachable too.
        graph.edges.retain(|e| e.from != "review");
        let text = compile(&graph);
        assert!(text.contains("Step 2: Run a fresh-eyes review"), "{text}");
        assert!(!text.contains("Step 3: "), "{text}");
        assert!(!text.contains("Push the branch"), "{text}");
    }

    #[test]
    fn test_branch_follows_first_edge_and_cycle_stops() {
        // Documented determinism: on a branch the FIRST outgoing edge in
        // edge-list order wins; a cycle stops before revisiting a node.
        let graph = WorkflowGraph {
            nodes: vec![
                WorkflowNode {
                    id: "a".into(),
                    text: "step a".into(),
                },
                WorkflowNode {
                    id: "b".into(),
                    text: "step b".into(),
                },
                WorkflowNode {
                    id: "c".into(),
                    text: "step c".into(),
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "a".into(),
                    to: "b".into(),
                },
                WorkflowEdge {
                    from: "a".into(),
                    to: "c".into(),
                }, // loser branch
                WorkflowEdge {
                    from: "b".into(),
                    to: "a".into(),
                }, // cycle back
            ],
            start: "a".to_string(),
        };
        assert_eq!(compile(&graph), "Step 1: step a Step 2: step b");
    }

    #[test]
    fn test_degenerate_graphs_compile_to_empty_or_partial() {
        // Start naming no node → empty.
        let graph = WorkflowGraph {
            nodes: vec![],
            edges: vec![],
            start: "missing".to_string(),
        };
        assert_eq!(compile(&graph), "");
        // An edge to a missing node ends the walk after the real steps.
        let graph = WorkflowGraph {
            nodes: vec![WorkflowNode {
                id: "a".into(),
                text: "only step".into(),
            }],
            edges: vec![WorkflowEdge {
                from: "a".into(),
                to: "ghost".into(),
            }],
            start: "a".to_string(),
        };
        assert_eq!(compile(&graph), "Step 1: only step");
        // Whitespace-only text contributes no step but the walk continues.
        let graph = WorkflowGraph {
            nodes: vec![
                WorkflowNode {
                    id: "a".into(),
                    text: "  \t ".into(),
                },
                WorkflowNode {
                    id: "b".into(),
                    text: "real\nstep".into(),
                },
            ],
            edges: vec![WorkflowEdge {
                from: "a".into(),
                to: "b".into(),
            }],
            start: "a".to_string(),
        };
        // …and embedded newlines are collapsed (paste safety).
        assert_eq!(compile(&graph), "Step 1: real step");
    }

    #[test]
    fn test_compiled_for_run_falls_back_to_the_default() {
        // Backward compat: a run config without a stored graph (pre-#91)
        // compiles the default template.
        assert_eq!(compiled_for_run(None), compile(&WorkflowGraph::default()));
        let custom = WorkflowGraph {
            nodes: vec![WorkflowNode {
                id: "x".into(),
                text: "custom".into(),
            }],
            edges: vec![],
            start: "x".to_string(),
        };
        assert_eq!(compiled_for_run(Some(&custom)), "Step 1: custom");
    }

    #[test]
    fn test_wire_shape_roundtrip() {
        // The serde types ARE the wire format the UI sends — snake-free
        // single-word keys, stable across a JSON roundtrip.
        let graph = WorkflowGraph::default();
        let json = serde_json::to_value(&graph).unwrap();
        assert!(json["nodes"][0]["id"].is_string());
        assert!(json["nodes"][0]["text"].is_string());
        assert!(json["edges"][0]["from"].is_string());
        assert!(json["edges"][0]["to"].is_string());
        assert_eq!(json["start"], "implement");
        let back: WorkflowGraph = serde_json::from_value(json).unwrap();
        assert_eq!(back, graph);
    }
}
