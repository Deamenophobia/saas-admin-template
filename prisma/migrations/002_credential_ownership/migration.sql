-- Exactly one owner, plus a composite service-account FK from the baseline.
ALTER TABLE "api_keys" ADD CONSTRAINT "ck_api_keys_one_owner"
  CHECK (("user_id" IS NOT NULL)::integer + ("service_account_id" IS NOT NULL)::integer = 1);
ALTER TABLE "api_keys" ADD CONSTRAINT "ck_api_keys_expiry"
  CHECK ("expires_at" > "created_at");
