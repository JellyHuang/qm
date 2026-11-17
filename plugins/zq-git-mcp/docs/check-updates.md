# check_updates delivery rule

`check_updates` delivers at least once. A stored branch tip advances only when the caller acknowledges what it received, so a lost response can duplicate commits but never lose them.

## Ordering

1. The caller polls: `check_updates({ repo? })`.
2. The service reads the remote heads, compares them with the stored tips, and computes the commit lists. It writes nothing except on the very first observation of a repository (nothing to lose then).
3. The response carries `ack`: one entry `{ repo, branch, from, to }` per reported branch. `from` is the stored tip the list started at (`null` for a branch never seen, the tombstone for a branch that was deleted and came back), `to` is the tip to store after the caller has processed the list (`null` for a deleted branch). When a list was cut to fit the response, `to` is the last reported commit.
4. The caller processes the commits, then passes the `ack` entries back in the next call: `check_updates({ repo?, ack })`. The service applies each entry only if the stored tip still equals `from`, then polls again in the same call.
5. Without an acknowledgement the next poll reports the same commits again. An acknowledgement that arrives twice, or after another caller already advanced the tip, matches nothing and changes nothing.

Concurrent callers each see the same commits until one acknowledges. Per repository, acknowledgement and polling run under one lock inside a service instance.

## Deleted branches are tombstones

The service role has no DELETE grant, so a deleted branch is never removed from the store. Its row keeps its place and its `tip_sha` is set to the fixed value `0000000000000000000000000000000000000000` (the tombstone), with `seen_at` updated.

- Reading: a tombstone means "deleted and already reported". It is not a current branch, is not reported as deleted again, and does not count in `branches`.
- Deleting: a branch that exists in the store but not on the remote is reported as `deleted` with `ack {from: <tip>, to: null}`. Applying that ack is one `UPDATE ... SET tip_sha = <tombstone>, seen_at = now() WHERE repo = $1 AND branch = $2 AND tip_sha = $3` with `$3` the reported tip. Without the ack the next poll reports the deletion again.
- Returning: a branch on the remote whose stored row is a tombstone is a new branch. The poll reports its tip commit, with `ack {from: <tombstone>, to: <tip>}`. Applying that ack is the same `UPDATE ... WHERE tip_sha = <tombstone>`, which replaces the tombstone. Without the ack it is reported as new again.
- First observation of a repository only happens when the store has no row for it at all; tombstones count as rows.

## Postgres mapping

Table `zq_git_branch_tips(repo, branch, tip_sha, seen_at)`, primary key `(repo, branch)`. The service role may SELECT, INSERT and UPDATE; nothing here needs DELETE.

- First observation: `INSERT ... ON CONFLICT (repo, branch) DO NOTHING` for every branch.
- Acknowledgement with a previous tip, including the tombstone: `UPDATE zq_git_branch_tips SET tip_sha = $to, seen_at = now() WHERE repo = $repo AND branch = $branch AND tip_sha = $from`. Zero rows updated means the entry was stale and is ignored.
- Acknowledgement of a branch never seen (`from` is null): `INSERT ... ON CONFLICT DO NOTHING`.
- Acknowledgement of a deletion (`to` is null): the same `UPDATE` with `$to` the tombstone.

The compare-and-set in the `WHERE` clause makes the rule hold across several service instances without a lock. The code is `TipStore` in `src/tip-store.ts` (memory) and `src/postgres/stores.ts`; the SQL is in `src/postgres/sql.ts`.
