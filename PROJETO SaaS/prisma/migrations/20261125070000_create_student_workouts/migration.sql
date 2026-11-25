CREATE TABLE "workout_exercises" (
    "id" TEXT NOT NULL,
    "personalId" TEXT NOT NULL,
    "workoutId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sets" INTEGER NOT NULL,
    "repetitions" INTEGER NOT NULL,
    "restSeconds" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workout_exercises_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workout_exercises_sets_check" CHECK ("sets" > 0),
    CONSTRAINT "workout_exercises_repetitions_check" CHECK ("repetitions" > 0),
    CONSTRAINT "workout_exercises_rest_seconds_check" CHECK ("restSeconds" >= 0),
    CONSTRAINT "workout_exercises_position_check" CHECK ("position" >= 0)
);

CREATE UNIQUE INDEX "workout_exercises_id_personalId_key"
ON "workout_exercises"("id", "personalId");

CREATE INDEX "workout_exercises_personalId_workoutId_position_idx"
ON "workout_exercises"("personalId", "workoutId", "position");

ALTER TABLE "workout_exercises"
ADD CONSTRAINT "workout_exercises_personalId_fkey"
FOREIGN KEY ("personalId") REFERENCES "personals"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workout_exercises"
ADD CONSTRAINT "workout_exercises_workout_tenant_fk"
FOREIGN KEY ("workoutId", "personalId") REFERENCES "workouts"("id", "personalId")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep the most recently updated active plan when older data contains duplicates.
WITH ranked_active_workouts AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "personalId", "studentId"
            ORDER BY "updatedAt" DESC, "createdAt" DESC, "id"
        ) AS position
    FROM "workouts"
    WHERE "active" = TRUE
)
UPDATE "workouts"
SET "active" = FALSE
FROM ranked_active_workouts
WHERE "workouts"."id" = ranked_active_workouts."id"
  AND ranked_active_workouts.position > 1;

-- Partial unique index enforces at most one active plan per student and tenant.
CREATE UNIQUE INDEX "workouts_one_active_per_student"
ON "workouts"("personalId", "studentId")
WHERE "active" = TRUE;
