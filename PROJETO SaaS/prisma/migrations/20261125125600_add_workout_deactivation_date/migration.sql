ALTER TABLE "workouts"
ADD COLUMN "deactivatedAt" TIMESTAMP(3);

UPDATE "workouts"
SET "deactivatedAt" = "updatedAt"
WHERE "active" = FALSE;
