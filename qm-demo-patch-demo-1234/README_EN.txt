QM patch package WP-1234-b0383898e73f  (repo demo-game-config, ticket WP-1234)

What this is: 2 changed file(s), made by QM. QM did not push anything, did not open a merge request and cannot see your repository. You apply the package and you own the commit.
Base commit: e09c9d79324bd5e017e94aeb2085bba41193f4e0 (it must exist in your clone; if not, run "git fetch" yourself, the script never fetches).

WINDOWS WARNING: apply.cmd and apply.ps1 are UNTESTED. Nobody has run them on a real Windows machine yet. apply.sh was tested on Linux with git 2.52 only.

Changes:
  M config/skill_levels.lua  [text]
  M data/skill_table.xlsx  [xlsx]

How to apply:
Step 1. Unzip the package. You get ONE folder named like this one (WP-1234-b0383898e73f). Put that WHOLE folder into the ROOT of your repository, the folder that contains .git. You need git 2.40 or newer.
Step 2. Check what would happen. Nothing is left behind. No folder argument is needed: the script uses the folder that contains the package folder as your repository.
        Linux, macOS, Git Bash:  sh WP-1234-b0383898e73f/apply.sh --dry-run
        Windows (UNTESTED):      WP-1234-b0383898e73f\apply.cmd --dry-run   (or double-click apply.cmd for the real run)
Step 3. Apply it for real (same command without --dry-run).
After a success you can delete the package folder. The script never deletes anything.

What the script does by default: it creates ONE local commit on the branch you are on. You are the author and the committer (your git user.name and user.email). The commit message already has the ticket id and these trailer lines at the end (AI-Generated: true marks the commit as AI generated):
        Ticket: WP-1234
        AI-Generated: true
The package folder stays in your repository as an untracked folder: git status shows it as "?? WP-1234-b0383898e73f/". It is never committed (the script adds only the files of the change) and the script never edits .gitignore or .git/info/exclude. The working tree must be clean for tracked files (untracked files are fine), you must be on a branch, and the branch must not be behind its upstream as of your last fetch. If anything fails or you press Ctrl-C the script puts the repository back exactly as it was.
The script refuses to start (exit 4, nothing touched) when: the package folder is not in the root of a repository (for example it is in a subfolder, or the parent is not a git repository); files of the package folder are tracked by your repository; or the change itself touches a path inside the package folder.
Review: git log -1 --stat   and   git show
Undo, only while the commit is not pushed (the script never pushes): git reset --keep <the original HEAD printed by the script>
Options:
  --dry-run            apply, show the result, then undo everything
  --new-branch         safer: build the commit on a new local branch qm/WP-1234-b0383898e73f made from the base commit in a temporary worktree; your branch and files are not touched. Undo: git switch - ; git branch -D qm/WP-1234-b0383898e73f
  --keep-bot-author    keep "QM Bot <qm-bot@invalid>" as the author (you stay the committer)
  --repo DIR           apply to the repository that contains DIR instead. The package folder may then be anywhere (also outside the repository). Use an absolute path with apply.cmd.
Exit codes: 0 done, 2 usage, 3 package damaged, 4 precondition failed (nothing touched), 5 apply failed (rolled back), 130 interrupted (rolled back).

Checks: apply.sh and manifest.json check each other and the package files against git blob ids. This finds damaged or incomplete downloads. It does NOT protect against someone who changes the files and the script together.
Windows: apply.cmd looks for the sh.exe of Git for Windows, runs apply.sh and, when started by a double-click, waits for a key at the end so you can read the result. apply.ps1 does the same from PowerShell. Both are UNTESTED.

Without the script (for graphical tools):
  git am --3way --keep-cr --keep-non-patch patches/0001.patch
Files and checksums: manifest.json. The commit message: COMMIT_MESSAGE.txt. The same text in Chinese: README_CN.txt.
