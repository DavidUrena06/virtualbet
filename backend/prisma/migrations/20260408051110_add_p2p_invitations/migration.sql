-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "p2p_invitations" (
    "id" TEXT NOT NULL,
    "private_bet_id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "invitee_id" TEXT NOT NULL,
    "selection" "BetSelection" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "p2p_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "p2p_invitations_private_bet_id_invitee_id_key" ON "p2p_invitations"("private_bet_id", "invitee_id");

-- AddForeignKey
ALTER TABLE "p2p_invitations" ADD CONSTRAINT "p2p_invitations_private_bet_id_fkey" FOREIGN KEY ("private_bet_id") REFERENCES "private_bets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_invitations" ADD CONSTRAINT "p2p_invitations_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_invitations" ADD CONSTRAINT "p2p_invitations_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
