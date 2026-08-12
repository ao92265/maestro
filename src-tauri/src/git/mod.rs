pub mod error;
pub mod ops;
pub mod runner;

pub use error::GitError;
pub use ops::{
    BranchInfo, CommitInfo, FileChange, FileDiff, FileDiffMode, GitUserConfig, RemoteInfo,
    WorktreeInfo, WorktreeStatus,
};
pub use runner::Git;
