QM patch package WP-1234-b0383898e73f  (repo demo-game-config, ticket WP-1234)
QM 补丁包 WP-1234-b0383898e73f  (repo demo-game-config, ticket WP-1234)

================================ ENGLISH ================================

What this is: 2 changed file(s), made by QM. QM did not push anything, did not open a merge request and cannot see your repository. You apply the package and you own the commit.
Base commit: e09c9d79324bd5e017e94aeb2085bba41193f4e0 (it must exist in your clone; if not, run "git fetch" yourself, the script never fetches).

Changes:
  M config/skill_levels.lua  [text]
  M data/skill_table.xlsx  [xlsx]

Step 1. Unzip the package into a folder OUTSIDE your repository. You need git 2.40 or newer.
Step 2. Check what would happen. Nothing is left behind:
        sh apply.sh --repo /path/to/your/clone --dry-run
Step 3. Apply it for real (same command without --dry-run):
        sh apply.sh --repo /path/to/your/clone

What the script does by default: it creates ONE local commit on the branch you are on. You are the author and the committer (your git user.name and user.email). The commit message already has the ticket id and these trailer lines at the end (AI-Generated: true marks the commit as AI generated):
        Ticket: WP-1234
        AI-Generated: true
The working tree must be clean (untracked files are fine), you must be on a branch, and the branch must not be behind its upstream as of your last fetch. If anything fails or you press Ctrl-C the script puts the repository back exactly as it was.
Review: git log -1 --stat   and   git show
Undo, only while the commit is not pushed (the script never pushes): git reset --keep <the original HEAD printed by the script>
Options:
  --dry-run            apply, show the result, then undo everything
  --new-branch         safer: build the commit on a new local branch qm/WP-1234-b0383898e73f made from the base commit in a temporary worktree; your branch and files are not touched. Undo: git switch - ; git branch -D qm/WP-1234-b0383898e73f
  --keep-bot-author    keep "QM Bot <qm-bot@invalid>" as the author (you stay the committer)
Exit codes: 0 done, 2 usage, 3 package damaged, 4 precondition failed (nothing touched), 5 apply failed (rolled back), 130 interrupted (rolled back).

Checks: apply.sh and manifest.json check each other and the package files against git blob ids. This finds damaged or incomplete downloads. It does NOT protect against someone who changes the files and the script together.
Windows: apply.cmd and apply.ps1 only call the sh that comes with Git for Windows. They are UNTESTED: nobody has run them on Windows yet. apply.sh was tested on Linux with git 2.52 only.

Without the script (for graphical tools):
  git am --3way --keep-cr --keep-non-patch patches/0001.patch
Files and checksums: manifest.json. The commit message: COMMIT_MESSAGE.txt.

================================ 中文 ================================

内容：共 2 个文件被修改，由 QM 生成。QM 没有推送任何内容，没有创建合并请求，也看不到你的仓库。补丁由你自己应用，提交由你负责。
基准提交：e09c9d79324bd5e017e94aeb2085bba41193f4e0（你的克隆里必须有这个提交；没有请自己执行 git fetch，脚本不会自动 fetch）。

修改列表见上方 Changes。

第 1 步：把压缩包解压到仓库之外的文件夹。需要 git 2.40 或更新版本。
第 2 步：先试运行，不会留下任何痕迹：
        sh apply.sh --repo /你的/克隆目录 --dry-run
第 3 步：正式应用（同一命令去掉 --dry-run）：
        sh apply.sh --repo /你的/克隆目录

默认行为：在你当前所在的分支上创建一个本地提交。作者和提交者都是你（你的 git user.name 和 user.email）。提交说明里已经带有工单号，末尾有这两行（AI-Generated: true 表示本提交由 AI 生成）：
        Ticket: WP-1234
        AI-Generated: true
要求：工作区干净（未跟踪文件没关系）、当前在某个分支上、且按你上次 fetch 的结果该分支没有落后于上游。任何一步失败或按 Ctrl-C，脚本都会把仓库完全恢复原样。
检查：git log -1 --stat   和   git show
撤销（仅限提交尚未推送；脚本本身从不推送）：git reset --keep <脚本打印的原 HEAD>
选项：
  --dry-run            应用、显示结果，然后完全撤销
  --new-branch         更安全：在临时工作树里从基准提交建立新的本地分支 qm/WP-1234-b0383898e73f，不动你当前的分支和文件。撤销：git switch - ；git branch -D qm/WP-1234-b0383898e73f
  --keep-bot-author    保留 "QM Bot <qm-bot@invalid>" 作为作者（你仍是提交者）
退出码：0 成功，2 参数错误，3 包文件损坏，4 前置条件不满足（未改动任何东西），5 应用失败（已回滚），130 被中断（已回滚）。

校验：apply.sh 与 manifest.json 会互相核对，并按 git blob id 核对包内文件，可以发现下载损坏或不完整；无法防范同时修改文件和脚本的人。
Windows：apply.cmd 和 apply.ps1 只是调用 Git for Windows 自带的 sh，尚未在任何 Windows 机器上运行，未经测试。apply.sh 只在 Linux、git 2.52 上测试过。

不用脚本（图形工具）：见上方 Without the script。文件与校验值见 manifest.json，提交说明见 COMMIT_MESSAGE.txt。
