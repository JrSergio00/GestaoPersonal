CREATE TYPE "Weekday" AS ENUM (
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
    'SATURDAY',
    'SUNDAY'
);

ALTER TABLE "workout_exercises"
ADD COLUMN "dayOfWeek" "Weekday";

DROP INDEX "workout_exercises_personalId_workoutId_position_idx";

CREATE INDEX "workout_exercises_personalId_workoutId_dayOfWeek_position_idx"
ON "workout_exercises"("personalId", "workoutId", "dayOfWeek", "position");
