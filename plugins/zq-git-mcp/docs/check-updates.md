# check_updates delivery rule

`check_updates` delivers at least once. A stored branch tip advances only when the caller acknowledges what it received, so a lost response can duplicate commits but never lose them.

## Ordering

1. The caller polls: `check_updates({ repo? })`.
2. The service reads the remote heads, compares them with the stored tips, and computes the commit lists. It writes nothing except on the very first observation of a repository (nothing to lose then).
3. The response carries `ack`: one entry `{ repo, branch, from, to }` per reported branch. `from` is the stored tip the list started at (`null` for a new branch), `to` is the tip to store after the caller has processed the list (`null` for a deleted branch). When a list was cut to fit the response, `to` is the last reported commit.
4. The caller processes the commits, then passes the `ack` entries back in the next call: `check_updates({ repo?, ack })`. The service applies each entry only if the stored tip still equals `from`, then polls again in the same call.
5. Without an acknowledgement the next poll reports the same commits again. An acknowledgement that arrives twice, or after another caller already advanced the tip, matches nothing and changes nothing.

Concurrent callers each see the same commits until one acknowledges. Per repository, acknowledgement and polling run under one lock inside a service instance.

## Postgres mapping

Table `zq_git_branch_tips(repo, branch, tip_sha, seen_at)`, primary key `(repo, branch)`.

- First observation: `INSERT ... ON CONFLICT DO NOTHING` for every branch.
- Acknowledgement with a previous tip: `UPDATE zq_git_branch_tips SET tip_sha = $to, seen_at = now() WHERE repo = $repo AND branch = $branch AND tip_sha = $from`. Zero rows updated means the entry was stale and is ignored.
- Acknowledgement of a new branch (`from` is null): `INSERT ... ON CONFLICT DO NOTHING`.
- Acknowledgement of a deleted branch (`to` is null): `DELETE ... WHERE repo = $repo AND branch = $branch AND tip_sha = $from`.

The compare-and-set in the `WHERE` clause makes the rule hold across several service instances without a lock.
