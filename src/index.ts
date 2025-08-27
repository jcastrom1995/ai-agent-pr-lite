import * as core from "@actions/core";
import * as github from "@actions/github";
import { execSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// --- Regex parsers -------------------------------------------------------
const FILE_BLOCK_RE = /```file:([^\n`]+)\n([\s\S]*?)```/gm;
const PATCH_BLOCK_RE = /```patch\n([\s\S]*?)```/gm;

function parseFileBlocks(
  body: string
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = FILE_BLOCK_RE.exec(body)) !== null) {
    const [, rawPath, content] = m;
    files.push({ path: rawPath.trim(), content });
  }
  return files;
}

function parsePatchBlocks(body: string): string[] {
  const patches: string[] = [];
  console.log("body", body);
  let m: RegExpExecArray | null;
  while ((m = PATCH_BLOCK_RE.exec(body)) !== null) {
    patches.push(m[1]);
  }
  return patches;
}

// --- Git helpers ---------------------------------------------------------
function sh(cmd: string) {
  core.info(`$ ${cmd}`);
  return execSync(cmd, { stdio: "inherit" });
}

function gitConfig(name: string, email: string) {
  sh(`git config user.name "${name}"`);
  sh(`git config user.email "${email}"`);
}

function ensureDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function writeFiles(files: Array<{ path: string; content: string }>): string[] {
  const applied: string[] = [];
  for (const { path, content } of files) {
    ensureDir(path);
    const data = content.replace(/\r\n/g, "\n");
    writeFileSync(path, data, { encoding: "utf8" });
    core.info(`wrote ${path} (${data.length} bytes)`);
    applied.push(path);
  }
  return applied;
}

function applyPatches(patches: string[]): {
  applied: string[];
  errors: string[];
} {
  const applied: string[] = [];
  const errors: string[] = [];
  patches.forEach((patch, idx) => {
    const name = `.ai-pr-agent.patch.${idx + 1}`;
    writeFileSync(name, patch, { encoding: "utf8" });
    const res = spawnSync("git", ["apply", name, "--whitespace=fix"], {
      stdio: "inherit",
    });
    if (res.status === 0) {
      applied.push(name);
    } else {
      errors.push(`Patch ${idx + 1} failed with exit ${res.status}`);
    }
    try {
      sh(`rm -f ${name}`);
    } catch {}
  });
  return { applied, errors };
}

function commitAndPush(message: string): { committed: boolean; msg: string } {
  try {
    sh("git add -A");
    // detect staged changes
    const diff = spawnSync("git", ["diff", "--cached", "--quiet"]);
    if (diff.status === 0) {
      return { committed: false, msg: "No changes to commit." };
    }
    sh(`git commit -m ${JSON.stringify(message)}`);
    sh("git push origin HEAD");
    return { committed: true, msg: "Changes pushed to PR branch." };
  } catch (e: any) {
    return {
      committed: false,
      msg: `Git operation failed: ${e?.message ?? e}`,
    };
  }
}

// --- GitHub comment ------------------------------------------------------
async function postComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issue_number: number,
  body: string
) {
  await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
}

// --- Main ----------------------------------------------------------------
async function run() {
  try {
    const ctx = github.context;
    if (!ctx.payload.pull_request) {
      core.info("Not a pull_request event; nothing to do.");
      return;
    }

    const pr = ctx.payload.pull_request as any;
    const prNumber: number = pr.number;
    const prBody: string = pr.body ?? "";

    // Configure git
    const gitUser = core.getInput("git-user-name") || "ai-pr-agent-lite";
    const gitEmail =
      core.getInput("git-user-email") || "ai-pr-agent@users.noreply.github.com";
    gitConfig(gitUser, gitEmail);

    // Parse blocks
    const fileBlocks = parseFileBlocks(prBody);
    const patchBlocks = parsePatchBlocks(prBody);

    const appliedFiles = fileBlocks.length ? writeFiles(fileBlocks) : [];
    const { applied: appliedPatches, errors: patchErrors } = patchBlocks.length
      ? applyPatches(patchBlocks)
      : { applied: [], errors: [] };

    const commitMsg =
      core.getInput("commit-message") ||
      "chore(ai-pr-agent): apply PR body changes";
    const { committed, msg } = commitAndPush(commitMsg);

    // Build comment
    const lines: string[] = ["### 🤖 AI PR Agent Lite — Applied changes", ""];
    if (appliedFiles.length) {
      lines.push("**Files created/updated:**");
      for (const p of appliedFiles) lines.push(`- \`${p}\``);
      lines.push("");
    }
    if (appliedPatches.length) {
      lines.push("**Patches applied:**");
      for (const p of appliedPatches) lines.push(`- \`${p}\``);
      lines.push("");
    }
    if (!appliedFiles.length && !appliedPatches.length) {
      lines.push(
        "No matching code blocks were found in the PR description, or no changes were necessary."
      );
    }
    if (patchErrors.length) {
      lines.push("\n**Errors:**");
      for (const e of patchErrors) lines.push(`- ${e}`);
    }
    if (msg) lines.push(`\n**Git:** ${msg}`);

    const comment = lines.join("\n");

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
    if (!token) {
      core.warning("GITHUB_TOKEN missing; cannot post comment.");
    } else {
      const octokit = github.getOctokit(token);
      await postComment(
        octokit,
        ctx.repo.owner,
        ctx.repo.repo,
        prNumber,
        comment
      );
      core.info("Posted PR comment.");
    }
  } catch (error: any) {
    core.setFailed(error?.message ?? String(error));
  }
}

run();
