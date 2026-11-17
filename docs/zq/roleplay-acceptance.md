# Role-play acceptance mode

A test-only mode for one person to walk a whole feature flow alone. Off by default; it never runs unless both variables are set.

| Variable               | Meaning                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `ZQ_ROLEPLAY_MM_USER`  | Mattermost user id of the tester. Every notice and every feature group goes to this user only    |
| `ZQ_ROLEPLAY_PROJECTS` | Comma-separated OpenProject project ids holding the test tickets. All other projects are ignored |

Setting one without the other fails at startup. The tester must have a confirmed identity link, because the scan runs as the tester.

## What changes

- Every OpenProject user resolves to a stand-in recipient `rp:<opUserId>` instead of a real Mattermost account. The chat boundary turns each stand-in into a message to the tester, so one change covers reminders, change digests, group creation, report cards and sub-order cards.
- Every direct message and card carries three header lines: `当前你扮演:<角色> <姓名>`, `本应推送给:<角色> <姓名>` (who would have received it outside the mode) and `推送理由:<规则 id>(<原因>)`. Change-digest bullets carry the same in one line, and the group's first message states why it was created. The reasons are the rule ids of the scanner plus `change-digest`, `report-draft`, `child-orders` and the group creation.
- A recipient that is neither the tester nor a stand-in is refused with an error. Nothing can reach a real person.
- Every direct message starts with `当前你扮演:<角色> <姓名>`. Every line of a change digest carries its own label, taken from the person the change is about (the assignee of an order, the planner of a feature), so "assigned to X" switches the role from that line on.
- Roles come from the ticket fields (planner, PM, reviewer, QA owner, acceptor, regression owner) and from the duty that owns an order's type (client, server, art, ...). A person holding several roles shows all of them.
- A feature group is created with only the tester (QM is the channel creator) and named `【角色扮演】<标题>`. Its first message lists every role the tester plays there.
- Sub-order cards and the personal daily report go to the tester as `当前你扮演:你本人`. Weekly project reports go to the stand-in of the project's PM; confirming such a card as the tester confirms it for that stand-in.

## Cleaning up

`roleplayReset()` on the runtime removes the stand-in personas, the reminders to stand-ins, and for every test feature its group row, change lines, snapshots, plus the change cursors of the test projects. Delete or archive the test project in OpenProject separately; the Mattermost channels created for it stay until archived by hand.

## Acceptance script

`test/zq-roleplay-acceptance.test.ts` drives one feature through create, assign, briefing group, development, hand-in, QA with a blocking bug, done, a sub-order proposal and the weekly PM report, and asserts that only the tester receives anything and every message names the role played. The same steps are what to do by hand in the test OpenProject project.
