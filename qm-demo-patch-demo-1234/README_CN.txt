QM 补丁包 WP-1234-b0383898e73f  (仓库 demo-game-config，工单 WP-1234)

内容：共 2 个文件被修改，由 QM 生成。QM 没有推送任何内容，没有创建合并请求，也看不到你的仓库。补丁由你自己应用，提交由你负责。
基准提交：e09c9d79324bd5e017e94aeb2085bba41193f4e0（你的克隆里必须有这个提交；没有请自己执行 git fetch，脚本不会自动 fetch）。

Windows 警告：apply.cmd 和 apply.ps1 未经测试，尚未在任何真实的 Windows 机器上运行过。apply.sh 只在 Linux、git 2.52 上测试过。

修改列表：
  M config/skill_levels.lua  [text]
  M data/skill_table.xlsx  [xlsx]

使用方法：
第 1 步：解压压缩包，得到一个文件夹（名字类似 WP-1234-b0383898e73f）。把这个文件夹整个放进你的仓库根目录（即包含 .git 的那个文件夹）。需要 git 2.40 或更新版本。
第 2 步：先试运行，不会留下任何痕迹。不需要任何目录参数：脚本把补丁包文件夹的上一级当作你的仓库。
        Linux、macOS、Git Bash：  sh WP-1234-b0383898e73f/apply.sh --dry-run
        Windows（未经测试）：     WP-1234-b0383898e73f\apply.cmd --dry-run   （正式运行也可以直接双击 apply.cmd）
第 3 步：正式应用（同一命令去掉 --dry-run）。
成功之后可以删除补丁包文件夹。脚本从不删除任何东西。

默认行为：在你当前所在的分支上创建一个本地提交。作者和提交者都是你（你的 git user.name 和 user.email）。提交说明里已经带有工单号，末尾有这两行（AI-Generated: true 表示本提交由 AI 生成）：
        Ticket: WP-1234
        AI-Generated: true
补丁包文件夹会作为未跟踪文件夹留在你的仓库里：git status 显示为 "?? WP-1234-b0383898e73f/"。它不会被提交（脚本只添加本次修改涉及的文件），脚本也从不修改 .gitignore 或 .git/info/exclude。要求：已跟踪的文件没有未提交的修改（未跟踪文件没关系）、当前在某个分支上、且按你上次 fetch 的结果该分支没有落后于上游。任何一步失败或按 Ctrl-C，脚本都会把仓库完全恢复原样。
以下情况脚本会拒绝启动（退出码 4，不改动任何东西）：补丁包文件夹不在仓库根目录（例如放在子文件夹里，或上一级不是 git 仓库）；补丁包文件夹里的文件已被你的仓库跟踪；本次修改本身涉及补丁包文件夹内的路径。
检查：git log -1 --stat   和   git show
撤销（仅限提交尚未推送；脚本本身从不推送）：git reset --keep <脚本打印的原 HEAD>
选项：
  --dry-run            应用、显示结果，然后完全撤销
  --new-branch         更安全：在临时工作树里从基准提交建立新的本地分支 qm/WP-1234-b0383898e73f，不动你当前的分支和文件。撤销：git switch - ；git branch -D qm/WP-1234-b0383898e73f
  --keep-bot-author    保留 "QM Bot <qm-bot@invalid>" 作为作者（你仍是提交者）
  --repo DIR           改为应用到包含 DIR 的仓库。此时补丁包文件夹可以放在任何位置（包括仓库之外）。apply.cmd 请使用绝对路径。
退出码：0 成功，2 参数错误，3 包文件损坏，4 前置条件不满足（未改动任何东西），5 应用失败（已回滚），130 被中断（已回滚）。

校验：apply.sh 与 manifest.json 会互相核对，并按 git blob id 核对包内文件，可以发现下载损坏或不完整；无法防范同时修改文件和脚本的人。
Windows：apply.cmd 会查找 Git for Windows 自带的 sh.exe 并运行 apply.sh，双击启动时结束前会等待按键，方便查看结果；apply.ps1 在 PowerShell 里做同样的事。两者都未经测试。

不用脚本（图形工具）：
  git am --3way --keep-cr --keep-non-patch patches/0001.patch
文件与校验值见 manifest.json，提交说明见 COMMIT_MESSAGE.txt。同样内容的英文版：README_EN.txt。
