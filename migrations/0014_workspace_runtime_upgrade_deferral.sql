-- When a runtime upgrade is held back because the user's workspace is busy, record when that drift
-- was first observed. Deferral is bounded by wall clock rather than by a deferral count: a browser
-- with an open project re-mints its capability every few minutes, so counting attempts would burn
-- the budget fastest for the users doing the most work. The column is cleared when a provisioning
-- claim commits, so it measures one uninterrupted stretch of being pinned on an old runtime.
ALTER TABLE user_computer_runtimes ADD COLUMN upgrade_deferred_since INTEGER;
