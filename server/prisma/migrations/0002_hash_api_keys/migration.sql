-- Store sha256(key) and the last 4 characters instead of the plaintext API key.
ALTER TABLE "api_keys" ADD COLUMN "key_hash" TEXT, ADD COLUMN "last4" TEXT;

UPDATE "api_keys" SET "key_hash" = encode(sha256(convert_to("key", 'UTF8')), 'hex'), "last4" = right("key", 4);

ALTER TABLE "api_keys" ALTER COLUMN "key_hash" SET NOT NULL, ALTER COLUMN "last4" SET NOT NULL;

DROP INDEX "api_keys_key_key";

ALTER TABLE "api_keys" DROP COLUMN "key";

CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
