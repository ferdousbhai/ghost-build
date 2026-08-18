-- `listing_skipped` says a sweep under-reports; it does not say what to go and look at.
-- Enforcement is gated on no run reporting a skip, so the operator needs the specific
-- listing that could not be read.
ALTER TABLE app_resource_reconcile_runs ADD COLUMN skipped_listings_json TEXT;
