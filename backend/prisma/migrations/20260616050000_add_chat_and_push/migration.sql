-- Chat de partidos
CREATE TABLE "match_messages" (
    "id"         TEXT NOT NULL,
    "match_id"   TEXT NOT NULL,
    "user_id"    TEXT NOT NULL,
    "message"    VARCHAR(280) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "match_messages_match_id_created_at_idx"
    ON "match_messages"("match_id", "created_at");

ALTER TABLE "match_messages"
    ADD CONSTRAINT "match_messages_match_id_fkey"
    FOREIGN KEY ("match_id") REFERENCES "matches"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "match_messages"
    ADD CONSTRAINT "match_messages_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Push subscriptions (Web Push API)
CREATE TABLE "push_subscriptions" (
    "id"         TEXT NOT NULL,
    "user_id"    TEXT NOT NULL,
    "endpoint"   TEXT NOT NULL,
    "p256dh"     TEXT NOT NULL,
    "auth"       TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key"
    ON "push_subscriptions"("endpoint");

CREATE INDEX "push_subscriptions_user_id_idx"
    ON "push_subscriptions"("user_id");

ALTER TABLE "push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
