/*
  Warnings:

  - You are about to drop the `bets` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `sessions` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "FriendshipStatus" AS ENUM ('PENDING', 'ACCEPTED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PrivateBetStatus" AS ENUM ('OPEN', 'LOCKED', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ParticipantStatus" AS ENUM ('ACTIVE', 'WON', 'LOST', 'REFUNDED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'P2P_INVITE', 'P2P_NEW_PARTICIPANT', 'P2P_LOCKED', 'P2P_RESOLVED', 'SPORT_BET_RESOLVED', 'ADMIN_MESSAGE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'P2P_BET_LOCK';
ALTER TYPE "TransactionType" ADD VALUE 'P2P_BET_WIN';
ALTER TYPE "TransactionType" ADD VALUE 'P2P_BET_REFUND';
ALTER TYPE "TransactionType" ADD VALUE 'P2P_COMMISSION';

-- DropForeignKey
ALTER TABLE "bets" DROP CONSTRAINT "bets_match_id_fkey";

-- DropForeignKey
ALTER TABLE "bets" DROP CONSTRAINT "bets_user_id_fkey";

-- DropForeignKey
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_fkey";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatar_emoji" TEXT NOT NULL DEFAULT '🎰';

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "locked_balance" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "bets";

-- DropTable
DROP TABLE "sessions";

-- CreateTable
CREATE TABLE "friendships" (
    "id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "addressee_id" TEXT NOT NULL,
    "status" "FriendshipStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sport_bets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "selection" "BetSelection" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "odd_at_bet" DECIMAL(6,2) NOT NULL,
    "potential_win" DECIMAL(18,2) NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "sport_bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_bets" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "min_amount" DECIMAL(18,2) NOT NULL,
    "max_participants" INTEGER NOT NULL DEFAULT 10,
    "house_commission" DECIMAL(4,4) NOT NULL DEFAULT 0.05,
    "total_pool" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "commission_taken" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "PrivateBetStatus" NOT NULL DEFAULT 'OPEN',
    "locked_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "private_bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "private_bet_participants" (
    "id" TEXT NOT NULL,
    "private_bet_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "selection" "BetSelection" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "payout" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "ParticipantStatus" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "private_bet_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "friendships_requester_id_addressee_id_key" ON "friendships"("requester_id", "addressee_id");

-- CreateIndex
CREATE UNIQUE INDEX "private_bet_participants_private_bet_id_user_id_key" ON "private_bet_participants"("private_bet_id", "user_id");

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_addressee_id_fkey" FOREIGN KEY ("addressee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sport_bets" ADD CONSTRAINT "sport_bets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sport_bets" ADD CONSTRAINT "sport_bets_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_bets" ADD CONSTRAINT "private_bets_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_bets" ADD CONSTRAINT "private_bets_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_bet_participants" ADD CONSTRAINT "private_bet_participants_private_bet_id_fkey" FOREIGN KEY ("private_bet_id") REFERENCES "private_bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "private_bet_participants" ADD CONSTRAINT "private_bet_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
