# Independent review — round 3

## Final independent verification — supersedes the verdict below

The three specific reproductions in this report now pass. Independently rerun:
85 existing tests passed, the original three independent lifecycle tests passed
(15 unrelated fixture tests skipped), TypeScript passed, lint reported no errors,
and Vite production build succeeded. Source inspection confirms removal of the
automatic transport retry, persisted operation results, fresh rollback revisions
with invalidated caches, and removal of the auth budget's 60-second timer.

The reported fixes are accepted within this review scope; no further code-change
round is requested for these findings. This is not a live-network release
certification: real proxy authentication and simultaneous-window E2E have not
been independently exercised. The documented storage-failure, manual-retry and
worker-lifetime limitations remain. Application source was unchanged during
this verification; dist was rebuilt. The temporary independent fixture was
removed from src and retained at /tmp/onlyproxy-review-final.test.ts.

The remainder is the historical failing assessment, retained for traceability.

Verdict: the earlier normal-path fixes are present, but two reliability blockers
and one retry-limit defect remain. Application source was not changed by this
review. Vite regenerated dist during validation. Branding is authorized.

## Independent validation

- Existing suite: 11 files / 82 tests passed.
- TypeScript: passed. Oxlint: no errors, warnings remain. Vite build: passed.
- Three additional lifecycle/failure tests against the real background message
  and auth handlers, with mocked Chrome APIs: all three failed as detailed below.
- Test fixture retained at `/tmp/onlyproxy-review-lifecycle.test.ts`. It copies
  the existing owner.test.ts harness and appends three tests named `independent:`.
  To reproduce, copy it to src/background/review-lifecycle.test.ts and run
  `node node_modules/vitest/vitest.mjs run src/background/review-lifecycle.test.ts -t independent`.
  The temporary source test was removed after this review.
- No live proxy/handshake or real two-window Edge E2E was performed.

## 1. High: deduplication disappears when the worker restarts

Location: src/background/background.ts, recentMutations and handleMutate;
src/services/ProxyService.ts, dispatchOp automatic retry.

Operation IDs/results exist only in a module-level Map. If an import is committed
but its response is lost when the worker terminates, the retry wakes a fresh
worker with an empty Map and repeats the operation. addMany appends duplicates;
ruleMove can move twice. The same opId does not prevent this across lifetimes.

Reproduction: execute addMany with opId='lost-response', re-import the background
module with the same persisted storage (simulated new worker), resend the same
operation and opId. Expected one profile with the imported ID; actual two.

Fix options: remove automatic transport retries and report uncertain completion
after refreshing state, or persist replay protection together with the mutation
and reconcile routing on restart. A separate non-atomic “remember op” write is
not sufficient to close the commit/response gap. Keep deduplication tests across
worker lifetimes, not just repeated calls within one module instance.

This lifecycle requirement is documented by Chrome: worker globals are lost on
shutdown, and unexpected termination must be handled.
[Official service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle#persist-data-rather-than-using-global-variables).

## 2. High: rollback restores the old revision and accepts stale tests

Location: src/background/background.ts, executeMutate rollback
(`chrome.storage.local.set({ state: prev })`); analogous local fallback in
src/services/ProxyService.ts.

The rollback restores the entire previous state, including routingRevision.
The new browser route may already have been installed before its post-apply
check fails. Restoring the old route and old revision makes that intervening
A -> B -> A invisible to acceptTest/acceptCurrentIp.

Reproduction: begin with A/revision 0; apply B successfully, fail the following
ownership query, allow rollback to A. Both proxy set calls occur. Submit a
successful A test carrying revision 0. Expected stale-route; actual ok:true.
This can misattribute a request made while B was temporarily installed to A.

Fix: revisions must never rewind when restoring configuration. Persist a fresh
revision for rollback and invalidate affected cached results. Test this failure
path alongside the existing successful A -> B -> A tests. Apply the same rule
to the dev fallback.

## 3. Medium: the 60-second timer still renews a live request's auth budget

Location: src/background/background.ts, trackAttempt.

Scheduling the timer only on the first attempt avoids multiple timers, but the
callback still deletes the request's attempt record after 60 seconds regardless
of whether it completed. The next challenge for that same live request becomes
attempt 1 again. Thus the asserted one-answer-per-request bound does not hold.

Reproduction with fake timers: authenticate request 'live', advance 60,001 ms
without a completion/error event, challenge 'live' again. Expected no credentials;
actual credentials returned again.

Fix: clear the budget on completion/error, or use cleanup that retains an
exhausted-request marker rather than renewing authorization. Account for worker
restarts if the bound is intended to cover the entire request lifetime. Keep a
fake-timer regression proving a long-lived request does not receive a new budget.

## Confirmed improvements

The production path no longer replays mutations locally on messaging failure;
test acceptance checks ownership/revision inside the background queue; deleted
rule targets use shared routing semantics; cleanup listeners now have filters;
initial storage failures receive structured responses. These changes are useful
and should be preserved. The remaining findings concern their lifecycle and
rollback boundaries, not cosmetic concerns or a request for a broad rewrite.
