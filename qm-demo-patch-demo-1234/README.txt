QM 补丁包 demo-1234（工单 WP-1234）  --  示例数据，作者与邮箱均为虚构
内容：patches/ 里是文本修改（git 邮件补丁），files/ 里是修改后的 data/skill_table.xlsx，manifest.json 记录校验值。
基准提交：0fd2d63c466a（本地必须已有这个提交，没有请先自己执行 git fetch）。
应用方法（在你自己的工作目录，工作区必须干净）：
  sh apply.sh --repo <你的克隆目录>
  Windows：apply.cmd --repo C:/你的克隆目录    或    powershell -ExecutionPolicy Bypass -File apply.ps1 -Repo C:\你的克隆目录
  （apply.cmd 和 apply.ps1 只是调用 Git for Windows 自带的 sh 运行 apply.sh，尚未在任何 Windows 机器上运行或测试。）
  先试运行不留任何痕迹：sh apply.sh --repo <目录> --dry-run ；提交者改为你本人：加 --reset-author
脚本会新建本地分支 qm/demo-1234（从基准提交出发，只含一个提交）。没有推送任何东西，也不会改动你当前所在的分支和工作区文件。
检查：git log qm/demo-1234      git diff 0fd2d63c466a..qm/demo-1234
使用：git switch qm/demo-1234（需要时再自己推送或合并）
撤销：如果已经切换过去，先 git switch - 回到原分支，然后 git branch -D qm/demo-1234
出错时脚本会停下并说明原因，仓库保持原样（不会留下分支或临时目录）。
退出码：0 成功，2 参数错误，3 包文件损坏，4 前置条件不满足，5 应用失败，130 被中断。
