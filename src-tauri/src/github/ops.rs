use serde::{Deserialize, Serialize};

use super::error::GitHubError;
use super::runner::GitHub;

/// Authentication status from `gh auth status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub username: Option<String>,
    pub scopes: Vec<String>,
}

/// Pull request information returned from `gh pr list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestInfo {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: PrAuthor,
    pub created_at: String,
    pub updated_at: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub is_draft: bool,
    pub additions: u64,
    pub deletions: u64,
    pub url: String,
    #[serde(default)]
    pub labels: Vec<PrLabel>,
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub closed_at: Option<String>,
}

/// Pull request author.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrAuthor {
    pub login: String,
}

/// Pull request label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrLabel {
    pub name: String,
    pub color: String,
}

/// The little a terminal header needs to link a branch to its pull request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchPullRequest {
    pub number: u64,
    pub title: String,
    /// `OPEN`, `MERGED` or `CLOSED`, as `gh` reports it.
    pub state: String,
    pub is_draft: bool,
    pub url: String,
}

/// One row of the branch → PR lookup, as `gh pr list --json` returns it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchPrRow {
    number: u64,
    title: String,
    state: String,
    is_draft: bool,
    url: String,
    updated_at: String,
}

/// Picks the one pull request a branch should link to.
///
/// A long-lived branch can carry several (one merged, one reopened, …). Open
/// beats everything else because that is the PR the user is working in; among
/// PRs of equal standing the most recently updated wins. Timestamps are RFC
/// 3339 in UTC as `gh` reports them, so comparing the strings orders them
/// correctly without parsing dates.
fn pick_branch_pull_request(rows: Vec<BranchPrRow>) -> Option<BranchPullRequest> {
    rows.into_iter()
        .max_by(|a, b| {
            let open = |r: &BranchPrRow| r.state.eq_ignore_ascii_case("open");
            open(a)
                .cmp(&open(b))
                .then_with(|| a.updated_at.cmp(&b.updated_at))
        })
        .map(|row| BranchPullRequest {
            number: row.number,
            title: row.title,
            state: row.state,
            is_draft: row.is_draft,
            url: row.url,
        })
}

/// Detailed pull request info including body and review info.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: PrAuthor,
    pub created_at: String,
    pub updated_at: String,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub is_draft: bool,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub url: String,
    #[serde(default)]
    pub labels: Vec<PrLabel>,
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub closed_at: Option<String>,
    #[serde(default)]
    pub mergeable: String,
    #[serde(default)]
    pub review_decision: Option<String>,
    #[serde(default)]
    pub comments: Vec<Comment>,
}

/// Issue information returned from `gh issue list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueInfo {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: PrAuthor,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    #[serde(default)]
    pub labels: Vec<PrLabel>,
    #[serde(default)]
    pub closed_at: Option<String>,
}

/// Discussion information returned from GraphQL API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionInfo {
    pub number: u64,
    pub title: String,
    pub category: DiscussionCategory,
    pub author: PrAuthor,
    pub created_at: String,
    pub url: String,
    #[serde(default)]
    pub answer_chosen_at: Option<String>,
}

/// Discussion category.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscussionCategory {
    pub name: String,
    pub emoji: String,
}

/// A comment on an issue, PR, or discussion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: PrAuthor,
    pub body: String,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub reactions: CommentReactions,
    /// For discussions: indicates if this comment is the accepted answer.
    #[serde(default)]
    pub is_answer: bool,
}

/// Reactions on a comment.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentReactions {
    pub total_count: u64,
    #[serde(default)]
    pub thumbs_up: u64,
    #[serde(default)]
    pub thumbs_down: u64,
    #[serde(default)]
    pub laugh: u64,
    #[serde(default)]
    pub hooray: u64,
    #[serde(default)]
    pub confused: u64,
    #[serde(default)]
    pub heart: u64,
    #[serde(default)]
    pub rocket: u64,
    #[serde(default)]
    pub eyes: u64,
}

/// Detailed issue info including body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: PrAuthor,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    #[serde(default)]
    pub labels: Vec<PrLabel>,
    #[serde(default)]
    pub closed_at: Option<String>,
    #[serde(default)]
    pub comments: Vec<Comment>,
}

/// Detailed discussion info including body.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub category: DiscussionCategory,
    pub author: PrAuthor,
    pub created_at: String,
    pub url: String,
    #[serde(default)]
    pub answer_chosen_at: Option<String>,
    #[serde(default)]
    pub comments: Vec<Comment>,
}

/// Filter options for listing pull requests.
#[derive(Debug, Clone, Default)]
pub struct PullRequestFilter {
    pub state: Option<String>,  // "open", "closed", "merged", "all"
    pub limit: Option<u32>,
    pub search: Option<String>,
}

/// Filter options for listing issues.
#[derive(Debug, Clone, Default)]
pub struct IssueFilter {
    pub state: Option<String>,  // "open", "closed", "all"
    pub limit: Option<u32>,
    pub search: Option<String>,
}

/// Merge method for pull requests.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    fn as_flag(&self) -> &'static str {
        match self {
            MergeMethod::Merge => "--merge",
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
        }
    }
}

/// Options for creating a pull request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePullRequestOptions {
    pub title: String,
    pub body: String,
    pub base: String,
    pub head: String,
    pub draft: bool,
}

/// GitHub operations using the `gh` CLI.
impl GitHub {
    /// Checks if the user is authenticated with GitHub.
    pub async fn auth_status(&self) -> Result<AuthStatus, GitHubError> {
        let result = self.run(&["auth", "status"]).await;

        match result {
            Ok(output) => {
                // Parse the output to extract username
                let stdout = output.stdout;
                let stderr = output.stderr;
                let combined = format!("{}\n{}", stdout, stderr);

                let username = combined
                    .lines()
                    .find(|line| line.contains("Logged in to"))
                    .and_then(|line| line.split("as ").nth(1))
                    .map(|s| s.trim().trim_end_matches(|c| c == ')' || c == ' ').to_string());

                Ok(AuthStatus {
                    logged_in: true,
                    username,
                    scopes: vec![],
                })
            }
            Err(GitHubError::NotAuthenticated) => {
                Ok(AuthStatus {
                    logged_in: false,
                    username: None,
                    scopes: vec![],
                })
            }
            Err(e) => Err(e),
        }
    }

    /// Lists pull requests with optional filtering.
    pub async fn list_pull_requests(
        &self,
        filter: PullRequestFilter,
    ) -> Result<Vec<PullRequestInfo>, GitHubError> {
        let mut args = vec![
            "pr", "list",
            "--json", "number,title,state,author,createdAt,updatedAt,headRefName,baseRefName,isDraft,additions,deletions,url,labels,mergedAt,closedAt",
        ];

        let state_arg;
        if let Some(ref state) = filter.state {
            state_arg = format!("--state={}", state);
            args.push(&state_arg);
        }

        let limit_arg;
        if let Some(limit) = filter.limit {
            limit_arg = format!("--limit={}", limit);
            args.push(&limit_arg);
        } else {
            args.push("--limit=50");
        }

        let search_arg;
        if let Some(ref search) = filter.search {
            search_arg = format!("--search={}", search);
            args.push(&search_arg);
        }

        self.run_json(&args).await
    }

    /// Finds the pull request opened from `branch`, if there is one.
    ///
    /// Powers the PR link in a terminal header, so it asks for the few fields a
    /// link needs and nothing else. `--state all` on purpose: a branch whose PR
    /// was merged or closed still deserves a link — that PR is where the work
    /// ended up. Open PRs win over closed ones, and among equals the most
    /// recently updated wins, because a long-lived branch can accumulate
    /// several.
    pub async fn pull_request_for_branch(
        &self,
        branch: &str,
    ) -> Result<Option<BranchPullRequest>, GitHubError> {
        let args = vec![
            "pr", "list",
            "--head", branch,
            "--state", "all",
            "--limit", "20",
            "--json", "number,title,state,isDraft,url,updatedAt",
        ];

        let rows: Vec<BranchPrRow> = self.run_json(&args).await?;
        Ok(pick_branch_pull_request(rows))
    }

    /// Gets detailed information about a specific pull request.
    pub async fn get_pull_request(&self, number: u64) -> Result<PullRequestDetail, GitHubError> {
        let number_str = number.to_string();
        let args = vec![
            "pr", "view", &number_str,
            "--json", "number,title,body,state,author,createdAt,updatedAt,headRefName,baseRefName,isDraft,additions,deletions,changedFiles,url,labels,mergedAt,closedAt,mergeable,reviewDecision,comments",
        ];

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PrViewResponse {
            number: u64,
            title: String,
            body: String,
            state: String,
            author: PrAuthor,
            created_at: String,
            updated_at: String,
            head_ref_name: String,
            base_ref_name: String,
            is_draft: bool,
            additions: u64,
            deletions: u64,
            changed_files: u64,
            url: String,
            #[serde(default)]
            labels: Vec<PrLabel>,
            #[serde(default)]
            merged_at: Option<String>,
            #[serde(default)]
            closed_at: Option<String>,
            #[serde(default)]
            mergeable: String,
            #[serde(default)]
            review_decision: Option<String>,
            #[serde(default)]
            comments: Vec<PrCommentRaw>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PrCommentRaw {
            id: String,
            author: PrAuthor,
            body: String,
            created_at: String,
            #[serde(default)]
            updated_at: Option<String>,
            #[serde(default)]
            reaction_groups: Vec<ReactionGroup>,
        }

        #[derive(Deserialize)]
        struct ReactionGroup {
            content: String,
            #[serde(default)]
            users: ReactionUsers,
        }

        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct ReactionUsers {
            total_count: u64,
        }

        let response: PrViewResponse = self.run_json(&args).await.map_err(|e| {
            if let GitHubError::CommandFailed { stderr, .. } = &e {
                if stderr.contains("Could not resolve") || stderr.contains("not found") {
                    return GitHubError::PullRequestNotFound { number };
                }
            }
            e
        })?;

        // Convert raw comments to Comment struct
        let comments: Vec<Comment> = response.comments.into_iter().map(|c| {
            let mut reactions = CommentReactions::default();
            for rg in &c.reaction_groups {
                let count = rg.users.total_count;
                reactions.total_count += count;
                match rg.content.as_str() {
                    "THUMBS_UP" => reactions.thumbs_up = count,
                    "THUMBS_DOWN" => reactions.thumbs_down = count,
                    "LAUGH" => reactions.laugh = count,
                    "HOORAY" => reactions.hooray = count,
                    "CONFUSED" => reactions.confused = count,
                    "HEART" => reactions.heart = count,
                    "ROCKET" => reactions.rocket = count,
                    "EYES" => reactions.eyes = count,
                    _ => {}
                }
            }
            Comment {
                id: c.id,
                author: c.author,
                body: c.body,
                created_at: c.created_at,
                updated_at: c.updated_at,
                reactions,
                is_answer: false,
            }
        }).collect();

        Ok(PullRequestDetail {
            number: response.number,
            title: response.title,
            body: response.body,
            state: response.state,
            author: response.author,
            created_at: response.created_at,
            updated_at: response.updated_at,
            head_ref_name: response.head_ref_name,
            base_ref_name: response.base_ref_name,
            is_draft: response.is_draft,
            additions: response.additions,
            deletions: response.deletions,
            changed_files: response.changed_files,
            url: response.url,
            labels: response.labels,
            merged_at: response.merged_at,
            closed_at: response.closed_at,
            mergeable: response.mergeable,
            review_decision: response.review_decision,
            comments,
        })
    }

    /// Creates a new pull request.
    pub async fn create_pull_request(
        &self,
        options: CreatePullRequestOptions,
    ) -> Result<PullRequestInfo, GitHubError> {
        let mut args = vec![
            "pr", "create",
            "--title", &options.title,
            "--body", &options.body,
            "--base", &options.base,
            "--head", &options.head,
        ];

        if options.draft {
            args.push("--draft");
        }

        // Create the PR and get its number from the output URL
        let output = self.run(&args).await?;
        let url = output.trimmed();

        // Extract PR number from URL (e.g., https://github.com/owner/repo/pull/123)
        let number: u64 = url
            .split('/')
            .last()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| GitHubError::ParseError {
                message: format!("Could not parse PR number from URL: {}", url),
            })?;

        // Fetch the full PR info
        let detail = self.get_pull_request(number).await?;

        Ok(PullRequestInfo {
            number: detail.number,
            title: detail.title,
            state: detail.state,
            author: detail.author,
            created_at: detail.created_at,
            updated_at: detail.updated_at,
            head_ref_name: detail.head_ref_name,
            base_ref_name: detail.base_ref_name,
            is_draft: detail.is_draft,
            additions: detail.additions,
            deletions: detail.deletions,
            url: detail.url,
            labels: detail.labels,
            merged_at: detail.merged_at,
            closed_at: detail.closed_at,
        })
    }

    /// Merges a pull request.
    pub async fn merge_pull_request(
        &self,
        number: u64,
        method: MergeMethod,
        delete_branch: bool,
    ) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        let mut args = vec!["pr", "merge", &number_str, method.as_flag()];

        if delete_branch {
            args.push("--delete-branch");
        }

        self.run(&args).await?;
        Ok(())
    }

    /// Closes a pull request without merging.
    pub async fn close_pull_request(&self, number: u64) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        self.run(&["pr", "close", &number_str]).await?;
        Ok(())
    }

    /// Adds a comment to a pull request.
    pub async fn comment_pull_request(&self, number: u64, body: &str) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        self.run(&["pr", "comment", &number_str, "--body", body]).await?;
        Ok(())
    }

    /// Lists issues with optional filtering.
    pub async fn list_issues(&self, filter: IssueFilter) -> Result<Vec<IssueInfo>, GitHubError> {
        let mut args = vec![
            "issue", "list",
            "--json", "number,title,state,author,createdAt,updatedAt,url,labels,closedAt",
        ];

        let state_arg;
        if let Some(ref state) = filter.state {
            state_arg = format!("--state={}", state);
            args.push(&state_arg);
        }

        let limit_arg;
        if let Some(limit) = filter.limit {
            limit_arg = format!("--limit={}", limit);
            args.push(&limit_arg);
        } else {
            args.push("--limit=50");
        }

        let search_arg;
        if let Some(ref search) = filter.search {
            search_arg = format!("--search={}", search);
            args.push(&search_arg);
        }

        self.run_json(&args).await
    }

    /// Gets detailed information about a specific issue.
    pub async fn get_issue(&self, number: u64) -> Result<IssueDetail, GitHubError> {
        let number_str = number.to_string();

        // First get the basic issue info with JSON
        let args = vec![
            "issue", "view", &number_str,
            "--json", "number,title,body,state,author,createdAt,updatedAt,url,labels,closedAt,comments",
        ];

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct IssueViewResponse {
            number: u64,
            title: String,
            body: String,
            state: String,
            author: PrAuthor,
            created_at: String,
            updated_at: String,
            url: String,
            #[serde(default)]
            labels: Vec<PrLabel>,
            #[serde(default)]
            closed_at: Option<String>,
            #[serde(default)]
            comments: Vec<IssueCommentRaw>,
        }

        // GitHub CLI returns comments with slightly different structure
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct IssueCommentRaw {
            id: String,
            author: PrAuthor,
            body: String,
            created_at: String,
            #[serde(default)]
            updated_at: Option<String>,
            #[serde(default)]
            reaction_groups: Vec<ReactionGroup>,
        }

        #[derive(Deserialize)]
        struct ReactionGroup {
            content: String,
            #[serde(default)]
            users: ReactionUsers,
        }

        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct ReactionUsers {
            total_count: u64,
        }

        let response: IssueViewResponse = self.run_json(&args).await.map_err(|e| {
            if let GitHubError::CommandFailed { stderr, .. } = &e {
                if stderr.contains("Could not resolve") || stderr.contains("not found") {
                    return GitHubError::IssueNotFound { number };
                }
            }
            e
        })?;

        // Convert raw comments to Comment struct
        let comments: Vec<Comment> = response.comments.into_iter().map(|c| {
            let mut reactions = CommentReactions::default();
            for rg in &c.reaction_groups {
                let count = rg.users.total_count;
                reactions.total_count += count;
                match rg.content.as_str() {
                    "THUMBS_UP" => reactions.thumbs_up = count,
                    "THUMBS_DOWN" => reactions.thumbs_down = count,
                    "LAUGH" => reactions.laugh = count,
                    "HOORAY" => reactions.hooray = count,
                    "CONFUSED" => reactions.confused = count,
                    "HEART" => reactions.heart = count,
                    "ROCKET" => reactions.rocket = count,
                    "EYES" => reactions.eyes = count,
                    _ => {}
                }
            }
            Comment {
                id: c.id,
                author: c.author,
                body: c.body,
                created_at: c.created_at,
                updated_at: c.updated_at,
                reactions,
                is_answer: false,
            }
        }).collect();

        Ok(IssueDetail {
            number: response.number,
            title: response.title,
            body: response.body,
            state: response.state,
            author: response.author,
            created_at: response.created_at,
            updated_at: response.updated_at,
            url: response.url,
            labels: response.labels,
            closed_at: response.closed_at,
            comments,
        })
    }

    /// Adds a comment to an issue.
    pub async fn comment_issue(&self, number: u64, body: &str) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        self.run(&["issue", "comment", &number_str, "--body", body]).await?;
        Ok(())
    }

    /// Closes an issue.
    pub async fn close_issue(&self, number: u64) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        self.run(&["issue", "close", &number_str]).await?;
        Ok(())
    }

    /// Reopens a closed issue.
    pub async fn reopen_issue(&self, number: u64) -> Result<(), GitHubError> {
        let number_str = number.to_string();
        self.run(&["issue", "reopen", &number_str]).await?;
        Ok(())
    }

    /// Lists discussions using the GraphQL API.
    pub async fn list_discussions(&self, limit: u32) -> Result<Vec<DiscussionInfo>, GitHubError> {
        // We need repo info first to fill in owner/name.
        let repo_output = self.run(&["repo", "view", "--json", "owner,name"]).await?;

        #[derive(Deserialize)]
        struct RepoInfo {
            owner: RepoOwner,
            name: String,
        }

        #[derive(Deserialize)]
        struct RepoOwner {
            login: String,
        }

        let repo_info: RepoInfo = serde_json::from_str(&repo_output.stdout)?;

        // Interpolate owner/name directly rather than via sequential
        // String::replace on shared placeholders: a login containing the literal
        // "REPO" would otherwise be partially rewritten by the second replace,
        // redirecting the query to a different repository. GitHub restricts
        // logins/repo names to [A-Za-z0-9._-], so they cannot break out of the
        // GraphQL string literal.
        let query = format!(
            r#"{{
                repository(owner: "{owner}", name: "{name}") {{
                    discussions(first: {limit}, orderBy: {{field: CREATED_AT, direction: DESC}}) {{
                        nodes {{
                            number
                            title
                            category {{
                                name
                                emoji
                            }}
                            author {{
                                login
                            }}
                            createdAt
                            url
                            answerChosenAt
                        }}
                    }}
                }}
            }}"#,
            owner = repo_info.owner.login,
            name = repo_info.name,
            limit = limit
        );

        let result = self.graphql(&query).await;

        match result {
            Ok(json) => {
                // Parse the nested response
                let discussions = json
                    .get("data")
                    .and_then(|d| d.get("repository"))
                    .and_then(|r| r.get("discussions"))
                    .and_then(|d| d.get("nodes"))
                    .ok_or_else(|| {
                        // Check if discussions are not enabled
                        if let Some(errors) = json.get("errors") {
                            if errors.to_string().contains("discussions") {
                                return GitHubError::DiscussionsNotEnabled;
                            }
                        }
                        GitHubError::ParseError {
                            message: "Could not parse discussions response".to_string(),
                        }
                    })?;

                let discussions: Vec<DiscussionInfo> = serde_json::from_value(discussions.clone())?;
                Ok(discussions)
            }
            Err(e) => {
                // Check if the error indicates discussions aren't enabled
                if let GitHubError::CommandFailed { stderr, .. } = &e {
                    if stderr.contains("Could not resolve") || stderr.contains("discussions") {
                        return Err(GitHubError::DiscussionsNotEnabled);
                    }
                }
                Err(e)
            }
        }
    }

    /// Gets detailed information about a specific discussion using GraphQL.
    pub async fn get_discussion(&self, number: u64) -> Result<DiscussionDetail, GitHubError> {
        // Get repo info first
        let repo_output = self.run(&["repo", "view", "--json", "owner,name"]).await?;

        #[derive(Deserialize)]
        struct RepoInfo {
            owner: RepoOwner,
            name: String,
        }

        #[derive(Deserialize)]
        struct RepoOwner {
            login: String,
        }

        let repo_info: RepoInfo = serde_json::from_str(&repo_output.stdout)?;

        let query = format!(
            r#"{{
                repository(owner: "{}", name: "{}") {{
                    discussion(number: {}) {{
                        number
                        title
                        body
                        category {{
                            name
                            emoji
                        }}
                        author {{
                            login
                        }}
                        createdAt
                        url
                        answerChosenAt
                        answer {{
                            id
                        }}
                        comments(first: 50) {{
                            nodes {{
                                id
                                author {{
                                    login
                                }}
                                body
                                createdAt
                                updatedAt
                                isAnswer
                                reactions {{
                                    totalCount
                                }}
                                reactionGroups {{
                                    content
                                    users {{
                                        totalCount
                                    }}
                                }}
                            }}
                        }}
                    }}
                }}
            }}"#,
            repo_info.owner.login, repo_info.name, number
        );

        let json = self.graphql(&query).await?;

        let discussion = json
            .get("data")
            .and_then(|d| d.get("repository"))
            .and_then(|r| r.get("discussion"))
            .ok_or_else(|| GitHubError::ParseError {
                message: format!("Discussion #{} not found", number),
            })?;

        // Parse the response
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DiscussionResponse {
            number: u64,
            title: String,
            body: String,
            category: DiscussionCategory,
            author: PrAuthor,
            created_at: String,
            url: String,
            answer_chosen_at: Option<String>,
            comments: CommentsNodes,
        }

        #[derive(Deserialize)]
        struct CommentsNodes {
            nodes: Vec<DiscussionCommentRaw>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct DiscussionCommentRaw {
            id: String,
            author: PrAuthor,
            body: String,
            created_at: String,
            #[serde(default)]
            updated_at: Option<String>,
            #[serde(default)]
            is_answer: bool,
            #[serde(default)]
            reaction_groups: Vec<ReactionGroup>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ReactionGroup {
            content: String,
            #[serde(default)]
            users: ReactionUsers,
        }

        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase")]
        struct ReactionUsers {
            total_count: u64,
        }

        let response: DiscussionResponse = serde_json::from_value(discussion.clone())?;

        // Convert raw comments to Comment struct
        let comments: Vec<Comment> = response.comments.nodes.into_iter().map(|c| {
            let mut reactions = CommentReactions::default();
            for rg in &c.reaction_groups {
                let count = rg.users.total_count;
                reactions.total_count += count;
                match rg.content.as_str() {
                    "THUMBS_UP" => reactions.thumbs_up = count,
                    "THUMBS_DOWN" => reactions.thumbs_down = count,
                    "LAUGH" => reactions.laugh = count,
                    "HOORAY" => reactions.hooray = count,
                    "CONFUSED" => reactions.confused = count,
                    "HEART" => reactions.heart = count,
                    "ROCKET" => reactions.rocket = count,
                    "EYES" => reactions.eyes = count,
                    _ => {}
                }
            }
            Comment {
                id: c.id,
                author: c.author,
                body: c.body,
                created_at: c.created_at,
                updated_at: c.updated_at,
                reactions,
                is_answer: c.is_answer,
            }
        }).collect();

        Ok(DiscussionDetail {
            number: response.number,
            title: response.title,
            body: response.body,
            category: response.category,
            author: response.author,
            created_at: response.created_at,
            url: response.url,
            answer_chosen_at: response.answer_chosen_at,
            comments,
        })
    }

    /// Adds a comment to a discussion using GraphQL mutation.
    pub async fn comment_discussion(&self, number: u64, body: &str) -> Result<(), GitHubError> {
        // Get repo info first
        let repo_output = self.run(&["repo", "view", "--json", "owner,name"]).await?;

        #[derive(Deserialize)]
        struct RepoInfo {
            owner: RepoOwner,
            name: String,
        }

        #[derive(Deserialize)]
        struct RepoOwner {
            login: String,
        }

        let repo_info: RepoInfo = serde_json::from_str(&repo_output.stdout)?;

        // First, get the discussion ID (GraphQL node ID)
        let id_query = format!(
            r#"{{
                repository(owner: "{}", name: "{}") {{
                    discussion(number: {}) {{
                        id
                    }}
                }}
            }}"#,
            repo_info.owner.login, repo_info.name, number
        );

        let id_json = self.graphql(&id_query).await?;

        let discussion_id = id_json
            .get("data")
            .and_then(|d| d.get("repository"))
            .and_then(|r| r.get("discussion"))
            .and_then(|d| d.get("id"))
            .and_then(|id| id.as_str())
            .ok_or_else(|| GitHubError::ParseError {
                message: format!("Could not get discussion ID for #{}", number),
            })?;

        // Escape the body for GraphQL
        let escaped_body = body
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n");

        // Now add the comment using mutation
        let mutation = format!(
            r#"mutation {{
                addDiscussionComment(input: {{discussionId: "{}", body: "{}"}}) {{
                    comment {{
                        id
                    }}
                }}
            }}"#,
            discussion_id, escaped_body
        );

        self.graphql(&mutation).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_method_flag() {
        assert_eq!(MergeMethod::Merge.as_flag(), "--merge");
        assert_eq!(MergeMethod::Squash.as_flag(), "--squash");
        assert_eq!(MergeMethod::Rebase.as_flag(), "--rebase");
    }

    #[test]
    fn test_pr_filter_default() {
        let filter = PullRequestFilter::default();
        assert!(filter.state.is_none());
        assert!(filter.limit.is_none());
        assert!(filter.search.is_none());
    }

    #[test]
    fn test_issue_filter_default() {
        let filter = IssueFilter::default();
        assert!(filter.state.is_none());
        assert!(filter.limit.is_none());
        assert!(filter.search.is_none());
    }

    #[test]
    fn test_auth_status_serialization() {
        let status = AuthStatus {
            logged_in: true,
            username: Some("testuser".to_string()),
            scopes: vec!["repo".to_string(), "read:org".to_string()],
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("testuser"));
        assert!(json.contains("true"));
    }

    fn branch_row(number: u64, state: &str, updated_at: &str) -> BranchPrRow {
        BranchPrRow {
            number,
            title: format!("PR {}", number),
            state: state.to_string(),
            is_draft: false,
            url: format!("https://github.com/owner/repo/pull/{}", number),
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn pick_branch_pr_returns_none_when_the_branch_has_no_pr() {
        assert!(pick_branch_pull_request(vec![]).is_none());
    }

    #[test]
    fn pick_branch_pr_prefers_an_open_pr_over_a_newer_merged_one() {
        let picked = pick_branch_pull_request(vec![
            branch_row(1, "OPEN", "2026-08-01T00:00:00Z"),
            branch_row(2, "MERGED", "2026-08-07T00:00:00Z"),
        ])
        .expect("a PR should be picked");
        assert_eq!(picked.number, 1);
    }

    #[test]
    fn pick_branch_pr_falls_back_to_the_most_recently_updated() {
        let picked = pick_branch_pull_request(vec![
            branch_row(1, "CLOSED", "2026-08-01T00:00:00Z"),
            branch_row(2, "MERGED", "2026-08-07T00:00:00Z"),
        ])
        .expect("a PR should be picked");
        assert_eq!(picked.number, 2);
        assert_eq!(picked.state, "MERGED");
    }

    #[test]
    fn pick_branch_pr_deserializes_the_gh_row_shape() {
        let json = r#"[{
            "number": 42,
            "title": "Add the thing",
            "state": "OPEN",
            "isDraft": true,
            "url": "https://github.com/owner/repo/pull/42",
            "updatedAt": "2026-08-07T09:00:00Z"
        }]"#;

        let rows: Vec<BranchPrRow> = serde_json::from_str(json).unwrap();
        let picked = pick_branch_pull_request(rows).expect("a PR should be picked");
        assert_eq!(picked.number, 42);
        assert!(picked.is_draft);
        assert_eq!(picked.url, "https://github.com/owner/repo/pull/42");
    }

    #[test]
    fn test_pr_info_deserialization() {
        let json = r#"{
            "number": 123,
            "title": "Test PR",
            "state": "OPEN",
            "author": {"login": "testuser"},
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-02T00:00:00Z",
            "headRefName": "feature-branch",
            "baseRefName": "main",
            "isDraft": false,
            "additions": 10,
            "deletions": 5,
            "url": "https://github.com/owner/repo/pull/123",
            "labels": []
        }"#;

        let pr: PullRequestInfo = serde_json::from_str(json).unwrap();
        assert_eq!(pr.number, 123);
        assert_eq!(pr.title, "Test PR");
        assert_eq!(pr.author.login, "testuser");
    }

    #[test]
    fn test_issue_info_deserialization() {
        let json = r#"{
            "number": 456,
            "title": "Test Issue",
            "state": "OPEN",
            "author": {"login": "testuser"},
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-01-02T00:00:00Z",
            "url": "https://github.com/owner/repo/issues/456",
            "labels": []
        }"#;

        let issue: IssueInfo = serde_json::from_str(json).unwrap();
        assert_eq!(issue.number, 456);
        assert_eq!(issue.title, "Test Issue");
    }
}
