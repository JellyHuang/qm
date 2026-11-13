# qm-oa-connector: QM as the OpenAgents master

QM joins a self-hosted OpenAgents (OA) workspace as the agent `qm-master` and coordinates worker agents (for example `qm-dev-worker`, a Claude Code agent on this host, and `op-dev-worker` on the OpenProject machine). **No LLM runs in this module.** QM's own agent does all the thinking; this module only relays messages.

```
Mattermost user ⇄ QM conversation ──(openagents tool)──▶ OA thread (master: qm-master) ⇄ workers
                       ▲                                              │
                       └──── poll: messages for @qm-master ◀──────────┘
```

## How it works

- **QM → OA:** the agent tool `openagents` supports these actions: `agents`, `threads`, `start_thread`, `send`, `status` and `create_task`.
  - `start_thread` creates an OA thread with `master: qm-master`, invites the workers, and sends the brief with `explicit_targets`.
  - It records the thread → conversation mapping in the table `openagents_threads`: thread name, QM principal, the Mattermost post that started the request (`anchorPostId`), the workers and any tasks.
- **OA → QM:** a background loop runs under a leader lease. It polls `/v1/events` for messages addressed to `qm-master`, batches them per thread, and continues the mapped Mattermost conversation **as the person who started it**, using a system note. Worker text is marked as external content.
  - QM then decides what to do next: answer the worker, ask the user in Mattermost, or report.
  - This works when no one is chatting, because the note starts a new turn in the stored session.
- **Delivery and recovery:**
  - The cursor is stored in `openagents_state`, and processed event ids in `openagents_seen` (kept for 7 days). Delivery is at-least-once from OA and effectively once in QM.
  - The QM turn key is `oa:<last event id>`, so a replay can't start a duplicate turn.
  - The loop rejoins after a 401, sends a heartbeat every 30 seconds, and backs off when it can't reach OA.

## Safety rules

- Only QM org admins, plus anyone in `OA_ALLOWED_PRINCIPALS`, can delegate.
- Delegation only starts from Mattermost turns, so worker replies have a conversation to return to.
- QM only delegates to workers listed in `OA_WORKERS`.
- A thread can only be used by the QM user who started it.
- A message from a thread QM didn't start gets one short reply in OA and never reaches a QM session.
- Each thread can wake QM at most 30 times an hour.
- The resumed turn runs as the original user, so it has exactly that user's permissions and scopes.

## Configuration (core env)

| Env                     | Meaning                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OA_URL`                | OA backend URL as core reaches it. Here it is `http://oa-backend:8000`, over the Docker network `oa-zq_oa` |
| `OA_WORKSPACE`          | Workspace id or slug                                                                                       |
| `OA_TOKEN`              | Workspace token. It is a secret with owner-level access in OA; pass it with `secretEnv`                    |
| `OA_WORKERS`            | Comma-separated worker agents QM may delegate to                                                           |
| `OA_AGENT_NAME`         | QM's agent name; default `qm-master`                                                                       |
| `OA_PUBLIC_URL`         | OA UI URL, used in links shown to people                                                                   |
| `OA_POLL_MS`            | Poll interval; default 3000                                                                                |
| `OA_ALLOWED_PRINCIPALS` | Extra QM users who may delegate                                                                            |

Verified against OpenAgents commit `1aeec218`:

- A custom (SDK/HTTP) agent can be a thread's master.
- `explicit_targets` reach agents that haven't been granted.
- A worker's reply with no mention goes to the master.
- Agents only _see_ agents they have been granted in `/v1/discover`. That's why the module uses `OA_WORKERS` instead of discovery.
