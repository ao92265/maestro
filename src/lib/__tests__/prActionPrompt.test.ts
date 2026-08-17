import { describe, expect, it } from "vitest";
import {
  buildPrActionPrompt,
  githubRepoSlug,
  type PrActionPromptInput,
  prActionBriefStem,
  prActionLaunchName,
} from "../prActionPrompt";

const REPO_PATH = "C:\\git\\maestro";

function input(overrides: Partial<PrActionPromptInput> = {}): PrActionPromptInput {
  return {
    pr: {
      number: 123,
      title: "feat(pr): monitoring tower",
      author: { login: "nachogl1" },
      headRefName: "feat/pr-monitor",
      baseRefName: "main",
      url: "https://github.com/nachogl1/maestro/pull/123",
    },
    repoPath: REPO_PATH,
    compiledSteps: "Step 1: Gather the full picture. Step 2: Review the diff.",
    needsWorktree: false,
    ...overrides,
  };
}

describe("githubRepoSlug", () => {
  it("derives owner/repo from a github.com pull request URL", () => {
    expect(githubRepoSlug("https://github.com/nachogl1/maestro/pull/123")).toBe("nachogl1/maestro");
  });

  it("works for an enterprise host and ignores anything after the number", () => {
    expect(githubRepoSlug("https://github.example.com/org/repo/pull/7/files")).toBe("org/repo");
  });

  it("returns null when the URL is not a pull request URL", () => {
    expect(githubRepoSlug("https://github.com/nachogl1/maestro/issues/9")).toBeNull();
    expect(githubRepoSlug("")).toBeNull();
  });
});

describe("buildPrActionPrompt step placeholders", () => {
  it("puts this run's PR number everywhere the steps say <PR>", () => {
    const prompt = buildPrActionPrompt(
      input({ compiledSteps: "Step 1: gh pr view <PR>. Step 2: gh pr diff <PR>." }),
    );
    expect(prompt).toContain("Step 1: gh pr view 123. Step 2: gh pr diff 123.");
    expect(prompt).not.toContain("<PR>");
  });

  it("leaves steps without the placeholder untouched", () => {
    const prompt = buildPrActionPrompt(input({ compiledSteps: "Step 1: read the comments." }));
    expect(prompt).toContain("Step 1: read the comments.");
  });
});

describe("prActionLaunchName", () => {
  it("names one step and a short chain in full", () => {
    expect(prActionLaunchName(123, ["check"])).toBe("PR #123 check");
    expect(prActionLaunchName(123, ["check", "review", "fix"])).toBe("PR #123 check+review+fix");
  });

  it("counts the steps instead when the chain would be long", () => {
    expect(prActionLaunchName(123, ["investigate-everything", "review-and-post-the-notes"])).toBe(
      "PR #123 2 steps",
    );
  });
});

describe("prActionBriefStem", () => {
  it("names the brief after the PR and the ticked steps", () => {
    expect(prActionBriefStem(123, ["check"])).toMatch(/^pr-123-check-[0-9a-f]{8}$/);
    expect(prActionBriefStem(123, ["check", "review"])).toMatch(
      /^pr-123-check-review-[0-9a-f]{8}$/,
    );
  });

  it("keeps only characters a file name can carry", () => {
    expect(prActionBriefStem(123, ["triage + verdict", "post NOTES"])).toMatch(
      /^pr-123-triage-verdict-post-notes-[0-9a-f]{8}$/,
    );
    expect(prActionBriefStem(123, ["../escape"])).toMatch(/^pr-123-escape-[0-9a-f]{8}$/);
    // Step ids with nothing usable in them still leave a legal stem.
    expect(prActionBriefStem(123, ["***"])).toMatch(/^pr-123-1-steps-[0-9a-f]{8}$/);
    expect(prActionBriefStem(123, [])).toBe("pr-123");
  });

  it("counts the steps instead when the chain would make a long name", () => {
    expect(prActionBriefStem(123, ["investigate-everything", "review-and-post-the-notes"])).toMatch(
      /^pr-123-2-steps-[0-9a-f]{8}$/,
    );
  });

  // Review finding C9: two DIFFERENT step selections must never name the same
  // brief file — the second launch would overwrite a running review's brief
  // before its agent had read it.
  it("never names two different step selections the same file", () => {
    // Same slug, different selection: the separator is lost to the slug.
    expect(prActionBriefStem(123, ["check", "review"])).not.toBe(
      prActionBriefStem(123, ["check-review"]),
    );
    // Both collapse to "2 steps": only a hash still tells them apart.
    expect(
      prActionBriefStem(123, ["investigate-everything", "review-and-post-the-notes"]),
    ).not.toBe(prActionBriefStem(123, ["investigate-everything", "review-and-post-the-nodes"]));
    // Deterministic: relaunching the same selection reuses one file.
    expect(prActionBriefStem(123, ["check", "review"])).toBe(
      prActionBriefStem(123, ["check", "review"]),
    );
    // A different PR is a different brief even with identical steps.
    expect(prActionBriefStem(123, ["check"])).not.toBe(prActionBriefStem(124, ["check"]));
  });

  // The backend slugs the stem it is handed (`[a-z0-9._-]`, issue #136 batch
  // A): a stem carrying anything else would be written under a different name
  // than the one the pointer quotes.
  it("survives the backend's own slugging unchanged", () => {
    for (const ids of [["check"], ["triage + verdict", "post NOTES"], ["***"], ["x".repeat(80)]]) {
      expect(prActionBriefStem(123, ids)).toMatch(/^[a-z0-9._-]+$/);
    }
  });
});

describe("buildPrActionPrompt", () => {
  it("names the PR unambiguously", () => {
    const prompt = buildPrActionPrompt(input());
    expect(prompt).toContain('PR: #123 "feat(pr): monitoring tower"');
    expect(prompt).toContain("Opened by: @nachogl1");
    expect(prompt).toContain("Branches: feat/pr-monitor -> main");
    expect(prompt).toContain("URL: https://github.com/nachogl1/maestro/pull/123");
    expect(prompt).toContain("Repository: nachogl1/maestro");
    expect(prompt).toContain(`Local checkout: ${REPO_PATH}`);
  });

  it("pins every gh call to the repo derived from the PR URL", () => {
    const prompt = buildPrActionPrompt(input());
    expect(prompt).toContain("pass --repo nachogl1/maestro on EVERY gh command");
    // Every gh command spelled out in the rules carries the pin too.
    for (const line of prompt.split("\n")) {
      if (!line.includes("gh pr ") && !line.includes("gh repo ")) continue;
      expect(line).toContain("--repo nachogl1/maestro");
    }
  });

  it("tells the agent to derive the slug when the URL does not carry one", () => {
    const prompt = buildPrActionPrompt(
      input({
        pr: { ...input().pr, url: "https://example.com/not-a-pr" },
      }),
    );
    expect(prompt).toContain("gh repo view --json nameWithOwner");
    expect(prompt).toContain(REPO_PATH);
    expect(prompt).toContain("--repo <owner/repo>");
    expect(prompt).not.toContain("--repo nachogl1/maestro");
  });

  it("carries the compiled steps verbatim under the process heading", () => {
    const compiledSteps = "Step 1: Do the first thing. Step 2: Do the second thing.";
    const prompt = buildPrActionPrompt(input({ compiledSteps }));
    expect(prompt).toContain(compiledSteps);
    expect(prompt.indexOf("PROCESS")).toBeLessThan(prompt.indexOf(compiledSteps));
  });

  it("always states the read-every-comment and stacked-PR rules", () => {
    for (const needsWorktree of [false, true]) {
      const prompt = buildPrActionPrompt(input({ needsWorktree }));
      expect(prompt).toContain("read EVERY existing comment and EVERY review thread");
      expect(prompt).toContain("the PR is STACKED");
      expect(prompt).toContain("NEVER merge it");
      expect(prompt).toContain("--json defaultBranchRef");
    }
  });

  it("demands a temporary worktree when a ticked step writes", () => {
    const prompt = buildPrActionPrompt(input({ needsWorktree: true }));
    expect(prompt).toContain("Create a NEW temporary git worktree");
    expect(prompt).toContain("checked out on the PR head branch feat/pr-monitor");
    expect(prompt).toContain(`NEVER switch branches in the main checkout at ${REPO_PATH}`);
    expect(prompt).not.toContain("READ-ONLY");
  });

  it("forbids touching the checkout when nothing ticked writes", () => {
    const prompt = buildPrActionPrompt(input({ needsWorktree: false }));
    expect(prompt).toContain("this run is READ-ONLY");
    expect(prompt).toContain("no commits, no pushes, no branch switches, no new worktrees");
    expect(prompt).not.toContain("git worktree add");
  });
});
