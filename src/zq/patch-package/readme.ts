export const APPLY_PS1 = `param(
  [string]$Repo = '.',
  [switch]$DryRun,
  [switch]$NewBranch,
  [switch]$KeepBotAuthor
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { [Console]::Error.WriteLine('QM apply: git is not installed or not on PATH'); exit 4 }
$root = Split-Path -Parent (Split-Path -Parent $git.Source)
$sh = Join-Path $root 'bin\\sh.exe'
if (-not (Test-Path $sh)) { $sh = Join-Path $root 'usr\\bin\\sh.exe' }
if (-not (Test-Path $sh)) { [Console]::Error.WriteLine('QM apply: sh.exe of Git for Windows not found'); exit 4 }
$repoFull = (Resolve-Path -LiteralPath $Repo).Path.Replace('\\', '/')
$argList = @('apply.sh', '--repo', $repoFull)
if ($DryRun) { $argList += '--dry-run' }
if ($NewBranch) { $argList += '--new-branch' }
if ($KeepBotAuthor) { $argList += '--keep-bot-author' }
Push-Location $here
try {
  & $sh @argList
  $rc = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $rc
`;

export const APPLY_CMD = `@echo off
setlocal
set "SH=%ProgramFiles%\\Git\\bin\\sh.exe"
if not exist "%SH%" set "SH=%ProgramFiles(x86)%\\Git\\bin\\sh.exe"
if not exist "%SH%" echo QM apply: Git for Windows not found 1>&2 & exit /b 4
cd /d "%~dp0"
"%SH%" apply.sh %*
exit /b %ERRORLEVEL%
`;

interface ReadmeChange {
  path: string;
  oldPath?: string;
  status: string;
  kind: string;
  part: string;
  comparison?: { available: boolean; file?: string; note?: string };
}

export interface ReadmeData {
  id: string;
  repo: string | undefined;
  ticket: string;
  base: string;
  authorName: string;
  authorEmail: string;
  changes: readonly ReadmeChange[];
  warnings: readonly string[];
  hasPatch: boolean;
  payloads: readonly { file: string; path: string }[];
}

const LISTED_CHANGES = 30;

function comparisonNote(comparison: ReadmeChange["comparison"]): string {
  if (!comparison) return "";
  return comparison.available
    ? `  (comparison table: ${comparison.file})`
    : "  (comparison not available for LFS files / LFS 文件无法生成对比表)";
}

function changeLines(data: ReadmeData): string {
  const lines = data.changes.slice(0, LISTED_CHANGES).map((change) => {
    const note = comparisonNote(change.comparison);
    const label = change.kind === "lfs" ? "LFS" : change.kind;
    return `  ${change.status} ${change.oldPath ? `${change.oldPath} -> ` : ""}${change.path}  [${label}]${note}`;
  });
  if (data.changes.length > LISTED_CHANGES) lines.push(`  ... and ${data.changes.length - LISTED_CHANGES} more`);
  return lines.join("\n");
}

export function renderReadme(data: ReadmeData): string {
  const lfsCount = data.payloads.length;
  const header = `${data.id}  (${data.repo ? `repo ${data.repo}, ` : ""}ticket ${data.ticket})`;
  const manual = [
    ...(data.hasPatch ? ["  git am --3way --keep-cr --keep-non-patch patches/0001.patch"] : []),
    ...data.payloads.map(
      (p) => `  copy ${p.file} to ${p.path} in your working copy, git add it, then commit (git-lfs must be installed)`,
    ),
  ].join("\n");
  const warnings = data.warnings.length
    ? `\nWarnings / 提示:\n${data.warnings.map((w) => `  - ${w}`).join("\n")}\n`
    : "";
  return `QM patch package ${header}
QM 补丁包 ${header}

================================ ENGLISH ================================

What this is: ${data.changes.length} changed file(s)${lfsCount ? `, ${lfsCount} of them stored with Git LFS` : ""}, made by QM. QM did not push anything, did not open a merge request and cannot see your repository. You apply the package and you own the commit.
Base commit: ${data.base} (it must exist in your clone; if not, run "git fetch" yourself, the script never fetches).

Changes:
${changeLines(data)}
${warnings}
Step 1. Unzip the package into a folder OUTSIDE your repository. You need git 2.40 or newer${lfsCount ? ", and git-lfs installed and enabled (git lfs install)" : ""}.
Step 2. Check what would happen. Nothing is left behind:
        sh apply.sh --repo /path/to/your/clone --dry-run
Step 3. Apply it for real (same command without --dry-run):
        sh apply.sh --repo /path/to/your/clone

What the script does by default: it creates ONE local commit on the branch you are on. You are the author and the committer (your git user.name and user.email). The commit message already has the ticket id and these trailer lines at the end (AI-Generated: true marks the commit as AI generated):
        Ticket: ${data.ticket}
        AI-Generated: true
The working tree must be clean (untracked files are fine), you must be on a branch, and the branch must not be behind its upstream as of your last fetch. If anything fails or you press Ctrl-C the script puts the repository back exactly as it was.
Review: git log -1 --stat   and   git show
Undo, only while the commit is not pushed (the script never pushes): git reset --keep <the original HEAD printed by the script>
Options:
  --dry-run            apply, show the result, then undo everything
  --new-branch         safer: build the commit on a new local branch qm/${data.id} made from the base commit in a temporary worktree; your branch and files are not touched. Undo: git switch - ; git branch -D qm/${data.id}
  --keep-bot-author    keep "${data.authorName} <${data.authorEmail}>" as the author (you stay the committer)
Exit codes: 0 done, 2 usage, 3 package damaged, 4 precondition failed (nothing touched), 5 apply failed (rolled back), 130 interrupted (rolled back).

Checks: apply.sh and manifest.json check each other and the package files against git blob ids. This finds damaged or incomplete downloads. It does NOT protect against someone who changes the files and the script together.
Windows: apply.cmd and apply.ps1 only call the sh that comes with Git for Windows. They are UNTESTED: nobody has run them on Windows yet. apply.sh was tested on Linux with git 2.52 only.

Without the script (for graphical tools):
${manual || "  (nothing to apply)"}
Files and checksums: manifest.json. The commit message: COMMIT_MESSAGE.txt.

================================ 中文 ================================

内容：共 ${data.changes.length} 个文件被修改${lfsCount ? `，其中 ${lfsCount} 个使用 Git LFS` : ""}，由 QM 生成。QM 没有推送任何内容，没有创建合并请求，也看不到你的仓库。补丁由你自己应用，提交由你负责。
基准提交：${data.base}（你的克隆里必须有这个提交；没有请自己执行 git fetch，脚本不会自动 fetch）。

修改列表见上方 Changes。

第 1 步：把压缩包解压到仓库之外的文件夹。需要 git 2.40 或更新版本${lfsCount ? "，并已安装并启用 git-lfs（git lfs install）" : ""}。
第 2 步：先试运行，不会留下任何痕迹：
        sh apply.sh --repo /你的/克隆目录 --dry-run
第 3 步：正式应用（同一命令去掉 --dry-run）：
        sh apply.sh --repo /你的/克隆目录

默认行为：在你当前所在的分支上创建一个本地提交。作者和提交者都是你（你的 git user.name 和 user.email）。提交说明里已经带有工单号，末尾有这两行（AI-Generated: true 表示本提交由 AI 生成）：
        Ticket: ${data.ticket}
        AI-Generated: true
要求：工作区干净（未跟踪文件没关系）、当前在某个分支上、且按你上次 fetch 的结果该分支没有落后于上游。任何一步失败或按 Ctrl-C，脚本都会把仓库完全恢复原样。
检查：git log -1 --stat   和   git show
撤销（仅限提交尚未推送；脚本本身从不推送）：git reset --keep <脚本打印的原 HEAD>
选项：
  --dry-run            应用、显示结果，然后完全撤销
  --new-branch         更安全：在临时工作树里从基准提交建立新的本地分支 qm/${data.id}，不动你当前的分支和文件。撤销：git switch - ；git branch -D qm/${data.id}
  --keep-bot-author    保留 "${data.authorName} <${data.authorEmail}>" 作为作者（你仍是提交者）
退出码：0 成功，2 参数错误，3 包文件损坏，4 前置条件不满足（未改动任何东西），5 应用失败（已回滚），130 被中断（已回滚）。

校验：apply.sh 与 manifest.json 会互相核对，并按 git blob id 核对包内文件，可以发现下载损坏或不完整；无法防范同时修改文件和脚本的人。
Windows：apply.cmd 和 apply.ps1 只是调用 Git for Windows 自带的 sh，尚未在任何 Windows 机器上运行，未经测试。apply.sh 只在 Linux、git 2.52 上测试过。

不用脚本（图形工具）：见上方 Without the script。文件与校验值见 manifest.json，提交说明见 COMMIT_MESSAGE.txt。
`;
}
