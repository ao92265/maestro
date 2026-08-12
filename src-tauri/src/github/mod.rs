pub mod error;
pub mod ops;
pub mod runner;
pub mod watchdog;

pub use error::GitHubError;
pub use ops::{
    AuthStatus, BranchPullRequest, CreatePullRequestOptions, DiscussionDetail, DiscussionInfo,
    IssueDetail, IssueFilter, IssueInfo, MergeMethod, PullRequestDetail, PullRequestFilter,
    PullRequestInfo,
};
pub use runner::GitHub;
pub use watchdog::{GitHubWatchdog, WatchedProject};
