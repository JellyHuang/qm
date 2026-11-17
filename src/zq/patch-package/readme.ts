export const APPLY_PS1 = `param(
  [string]$Repo,
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
$argList = @('apply.sh')
if ($Repo) { $argList += @('--repo', (Resolve-Path -LiteralPath $Repo).Path.Replace('\\', '/')) }
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
set "SH="
set "DOUBLE="
set "RC=0"
echo %CMDCMDLINE% | find /i "/c" >nul && set "DOUBLE=1"
for /f "delims=" %%G in ('where git 2^>nul') do if not defined SH call :probe "%%~dpG"
if not defined SH call :probe "%ProgramFiles%\\Git\\cmd\\"
if not defined SH call :probe "%ProgramFiles(x86)%\\Git\\cmd\\"
if not defined SH call :probe "%LocalAppData%\\Programs\\Git\\cmd\\"
if not defined SH echo QM apply: Git for Windows was not found. Install it from https://git-scm.com/download/win and run this file again. 1>&2 & set "RC=4" & goto done
cd /d "%~dp0"
"%SH%" apply.sh %*
set "RC=%ERRORLEVEL%"
:done
if defined DOUBLE pause
exit /b %RC%
:probe
if exist "%~1..\\usr\\bin\\sh.exe" set "SH=%~1..\\usr\\bin\\sh.exe"
if not defined SH if exist "%~1..\\bin\\sh.exe" set "SH=%~1..\\bin\\sh.exe"
exit /b 0
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
  hasPatch: boolean;
  payloads: readonly { file: string; path: string }[];
}

interface Readmes {
  cn: string;
  en: string;
}

const LISTED_CHANGES = 30;

function changeLines(data: ReadmeData, text: { comparison: string; noComparison: string; more: string }): string {
  const lines = data.changes.slice(0, LISTED_CHANGES).map((change) => {
    const { comparison } = change;
    const note = comparison
      ? `  (${comparison.available ? `${text.comparison}: ${comparison.file}` : text.noComparison})`
      : "";
    const label = change.kind === "lfs" ? "LFS" : change.kind;
    return `  ${change.status} ${change.oldPath ? `${change.oldPath} -> ` : ""}${change.path}  [${label}]${note}`;
  });
  if (data.changes.length > LISTED_CHANGES)
    lines.push(`  ${text.more.replace("N", String(data.changes.length - LISTED_CHANGES))}`);
  return lines.join("\n");
}

function manualLines(data: ReadmeData, copy: (file: string, path: string) => string): string {
  return [
    ...(data.hasPatch ? ["  git am --3way --keep-cr --keep-non-patch patches/0001.patch"] : []),
    ...data.payloads.map((p) => copy(p.file, p.path)),
  ].join("\n");
}

function renderEnglish(data: ReadmeData): string {
  const lfsCount = data.payloads.length;
  const header = `${data.id}  (${data.repo ? `repo ${data.repo}, ` : ""}ticket ${data.ticket})`;
  const changes = changeLines(data, {
    comparison: "comparison table",
    noComparison: "comparison not available for LFS files",
    more: "... and N more",
  });
  const manual =
    manualLines(
      data,
      (file, path) =>
        `  copy ${file} to ${path} in your working copy, git add it, then commit (git-lfs must be installed)`,
    ) || "  (nothing to apply)";
  return `QM patch package ${header}

What this is: ${data.changes.length} changed file(s)${lfsCount ? `, ${lfsCount} of them stored with Git LFS` : ""}, made by QM. QM did not push anything, did not open a merge request and cannot see your repository. You apply the package and you own the commit.
Base commit: ${data.base} (it must exist in your clone; if not, run "git fetch" yourself, the script never fetches).

WINDOWS WARNING: apply.cmd and apply.ps1 are UNTESTED. Nobody has run them on a real Windows machine yet. apply.sh was tested on Linux with git 2.52 only.

Changes:
${changes}

How to apply:
Step 1. Unzip the package. You get ONE folder named like this one (${data.id}). Put that WHOLE folder into the ROOT of your repository, the folder that contains .git. You need git 2.40 or newer${lfsCount ? ", and git-lfs installed and enabled (git lfs install)" : ""}.
Step 2. Check what would happen. Nothing is left behind. No folder argument is needed: the script uses the folder that contains the package folder as your repository.
        Linux, macOS, Git Bash:  sh ${data.id}/apply.sh --dry-run
        Windows (UNTESTED):      ${data.id}\\apply.cmd --dry-run   (or double-click apply.cmd for the real run)
Step 3. Apply it for real (same command without --dry-run).
After a success you can delete the package folder. The script never deletes anything.

What the script does by default: it creates ONE local commit on the branch you are on. You are the author and the committer (your git user.name and user.email). The commit message already has the ticket id and these trailer lines at the end (AI-Generated: true marks the commit as AI generated):
        Ticket: ${data.ticket}
        AI-Generated: true
The package folder stays in your repository as an untracked folder: git status shows it as "?? ${data.id}/". It is never committed (the script adds only the files of the change) and the script never edits .gitignore or .git/info/exclude. The working tree must be clean for tracked files (untracked files are fine), you must be on a branch, and the branch must not be behind its upstream as of your last fetch. If anything fails or you press Ctrl-C the script puts the repository back exactly as it was.
The script refuses to start (exit 4, nothing touched) when: the package folder is not in the root of a repository (for example it is in a subfolder, or the parent is not a git repository); files of the package folder are tracked by your repository; or the change itself touches a path inside the package folder.
Review: git log -1 --stat   and   git show
Undo, only while the commit is not pushed (the script never pushes): git reset --keep <the original HEAD printed by the script>
Options:
  --dry-run            apply, show the result, then undo everything
  --new-branch         safer: build the commit on a new local branch qm/${data.id} made from the base commit in a temporary worktree; your branch and files are not touched. Undo: git switch - ; git branch -D qm/${data.id}
  --keep-bot-author    keep "${data.authorName} <${data.authorEmail}>" as the author (you stay the committer)
  --repo DIR           apply to the repository that contains DIR instead. The package folder may then be anywhere (also outside the repository). Use an absolute path with apply.cmd.
Exit codes: 0 done, 2 usage, 3 package damaged, 4 precondition failed (nothing touched), 5 apply failed (rolled back), 130 interrupted (rolled back).

Checks: apply.sh and manifest.json check each other and the package files against git blob ids. This finds damaged or incomplete downloads. It does NOT protect against someone who changes the files and the script together.
Windows: apply.cmd looks for the sh.exe of Git for Windows, runs apply.sh and, when started by a double-click, waits for a key at the end so you can read the result. apply.ps1 does the same from PowerShell. Both are UNTESTED.

Without the script (for graphical tools):
${manual}
Files and checksums: manifest.json. The commit message: COMMIT_MESSAGE.txt. The same text in Chinese: README_CN.txt.
`;
}

function renderChinese(data: ReadmeData): string {
  const lfsCount = data.payloads.length;
  const header = `${data.id}  (${data.repo ? `仓库 ${data.repo}，` : ""}工单 ${data.ticket})`;
  const changes = changeLines(data, {
    comparison: "对比表",
    noComparison: "LFS 文件无法生成对比表",
    more: "... 另有 N 个",
  });
  const manual =
    manualLines(
      data,
      (file, path) => `  把 ${file} 复制为你工作区里的 ${path}，git add，再提交（需要已安装 git-lfs）`,
    ) || "  （没有需要应用的内容）";
  return `QM 补丁包 ${header}

内容：共 ${data.changes.length} 个文件被修改${lfsCount ? `，其中 ${lfsCount} 个使用 Git LFS` : ""}，由 QM 生成。QM 没有推送任何内容，没有创建合并请求，也看不到你的仓库。补丁由你自己应用，提交由你负责。
基准提交：${data.base}（你的克隆里必须有这个提交；没有请自己执行 git fetch，脚本不会自动 fetch）。

Windows 警告：apply.cmd 和 apply.ps1 未经测试，尚未在任何真实的 Windows 机器上运行过。apply.sh 只在 Linux、git 2.52 上测试过。

修改列表：
${changes}

使用方法：
第 1 步：解压压缩包，得到一个文件夹（名字类似 ${data.id}）。把这个文件夹整个放进你的仓库根目录（即包含 .git 的那个文件夹）。需要 git 2.40 或更新版本${lfsCount ? "，并已安装并启用 git-lfs（git lfs install）" : ""}。
第 2 步：先试运行，不会留下任何痕迹。不需要任何目录参数：脚本把补丁包文件夹的上一级当作你的仓库。
        Linux、macOS、Git Bash：  sh ${data.id}/apply.sh --dry-run
        Windows（未经测试）：     ${data.id}\\apply.cmd --dry-run   （正式运行也可以直接双击 apply.cmd）
第 3 步：正式应用（同一命令去掉 --dry-run）。
成功之后可以删除补丁包文件夹。脚本从不删除任何东西。

默认行为：在你当前所在的分支上创建一个本地提交。作者和提交者都是你（你的 git user.name 和 user.email）。提交说明里已经带有工单号，末尾有这两行（AI-Generated: true 表示本提交由 AI 生成）：
        Ticket: ${data.ticket}
        AI-Generated: true
补丁包文件夹会作为未跟踪文件夹留在你的仓库里：git status 显示为 "?? ${data.id}/"。它不会被提交（脚本只添加本次修改涉及的文件），脚本也从不修改 .gitignore 或 .git/info/exclude。要求：已跟踪的文件没有未提交的修改（未跟踪文件没关系）、当前在某个分支上、且按你上次 fetch 的结果该分支没有落后于上游。任何一步失败或按 Ctrl-C，脚本都会把仓库完全恢复原样。
以下情况脚本会拒绝启动（退出码 4，不改动任何东西）：补丁包文件夹不在仓库根目录（例如放在子文件夹里，或上一级不是 git 仓库）；补丁包文件夹里的文件已被你的仓库跟踪；本次修改本身涉及补丁包文件夹内的路径。
检查：git log -1 --stat   和   git show
撤销（仅限提交尚未推送；脚本本身从不推送）：git reset --keep <脚本打印的原 HEAD>
选项：
  --dry-run            应用、显示结果，然后完全撤销
  --new-branch         更安全：在临时工作树里从基准提交建立新的本地分支 qm/${data.id}，不动你当前的分支和文件。撤销：git switch - ；git branch -D qm/${data.id}
  --keep-bot-author    保留 "${data.authorName} <${data.authorEmail}>" 作为作者（你仍是提交者）
  --repo DIR           改为应用到包含 DIR 的仓库。此时补丁包文件夹可以放在任何位置（包括仓库之外）。apply.cmd 请使用绝对路径。
退出码：0 成功，2 参数错误，3 包文件损坏，4 前置条件不满足（未改动任何东西），5 应用失败（已回滚），130 被中断（已回滚）。

校验：apply.sh 与 manifest.json 会互相核对，并按 git blob id 核对包内文件，可以发现下载损坏或不完整；无法防范同时修改文件和脚本的人。
Windows：apply.cmd 会查找 Git for Windows 自带的 sh.exe 并运行 apply.sh，双击启动时结束前会等待按键，方便查看结果；apply.ps1 在 PowerShell 里做同样的事。两者都未经测试。

不用脚本（图形工具）：
${manual}
文件与校验值见 manifest.json，提交说明见 COMMIT_MESSAGE.txt。同样内容的英文版：README_EN.txt。
`;
}

export function renderReadmes(data: ReadmeData): Readmes {
  return { cn: renderChinese(data), en: renderEnglish(data) };
}
