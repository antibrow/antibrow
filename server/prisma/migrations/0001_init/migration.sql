-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mi" INTEGER NOT NULL,
    "max_synced_profiles" INTEGER NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "plan_id" TEXT NOT NULL,
    "plan_expires_at" TIMESTAMP(3),
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "client_id" TEXT,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tags" TEXT NOT NULL,
    "ua" TEXT,
    "browser_version" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "proxy_id" TEXT,
    "config" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "crypt_key" TEXT,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_proxies" (
    "id" TEXT NOT NULL,
    "client_id" TEXT,
    "user_id" TEXT NOT NULL,
    "config" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_proxies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE INDEX "users_plan_id_idx" ON "users"("plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_key" ON "api_keys"("key");

-- CreateIndex
CREATE INDEX "api_keys_user_id_idx" ON "api_keys"("user_id");

-- CreateIndex
CREATE INDEX "profiles_user_id_idx" ON "profiles"("user_id");

-- CreateIndex
CREATE INDEX "profiles_user_id_updated_at_idx" ON "profiles"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_user_id_client_id_key" ON "profiles"("user_id", "client_id");

-- CreateIndex
CREATE INDEX "user_proxies_user_id_updated_at_idx" ON "user_proxies"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_proxies_user_id_client_id_key" ON "user_proxies"("user_id", "client_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_proxies" ADD CONSTRAINT "user_proxies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Builtin default plan
INSERT INTO "plans" ("id", "code", "name", "mi", "max_synced_profiles", "is_default", "builtin", "updated_at")
VALUES ('plan_builtin_free', 'FREE', 'Free', 1, 0, true, true, CURRENT_TIMESTAMP);

-- At most one default plan
CREATE UNIQUE INDEX "plans_single_default" ON "plans" ("is_default") WHERE "is_default";
