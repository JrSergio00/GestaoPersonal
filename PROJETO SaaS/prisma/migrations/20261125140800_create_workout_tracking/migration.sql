CREATE TABLE "workout_sessions" (
    "id" TEXT NOT NULL,
    "personalId" TEXT NOT NULL,
    "workoutId" TEXT NOT NULL,
    "dayOfWeek" "Weekday" NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workout_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workout_set_logs" (
    "id" TEXT NOT NULL,
    "personalId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "workoutId" TEXT NOT NULL,
    "workoutExerciseId" TEXT NOT NULL,
    "setNumber" INTEGER NOT NULL,
    "repetitions" INTEGER NOT NULL,
    "loadKg" DECIMAL(8,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workout_set_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workout_set_logs_set_number_check" CHECK ("setNumber" > 0),
    CONSTRAINT "workout_set_logs_repetitions_check" CHECK ("repetitions" >= 0),
    CONSTRAINT "workout_set_logs_load_check" CHECK ("loadKg" >= 0)
);

CREATE UNIQUE INDEX "workout_exercises_id_workoutId_personalId_key"
ON "workout_exercises"("id", "workoutId", "personalId");

CREATE UNIQUE INDEX "workout_sessions_id_personalId_key"
ON "workout_sessions"("id", "personalId");

CREATE UNIQUE INDEX "workout_sessions_id_workoutId_personalId_key"
ON "workout_sessions"("id", "workoutId", "personalId");

CREATE INDEX "workout_sessions_personalId_workoutId_performedAt_idx"
ON "workout_sessions"("personalId", "workoutId", "performedAt");

CREATE UNIQUE INDEX "workout_set_logs_sessionId_workoutExerciseId_setNumber_key"
ON "workout_set_logs"("sessionId", "workoutExerciseId", "setNumber");

CREATE INDEX "workout_set_logs_personalId_workoutExerciseId_idx"
ON "workout_set_logs"("personalId", "workoutExerciseId");

ALTER TABLE "workout_sessions"
ADD CONSTRAINT "workout_sessions_personalId_fkey"
FOREIGN KEY ("personalId") REFERENCES "personals"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workout_sessions"
ADD CONSTRAINT "workout_sessions_workout_tenant_fk"
FOREIGN KEY ("workoutId", "personalId") REFERENCES "workouts"("id", "personalId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workout_set_logs"
ADD CONSTRAINT "workout_set_logs_personalId_fkey"
FOREIGN KEY ("personalId") REFERENCES "personals"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workout_set_logs"
ADD CONSTRAINT "workout_set_logs_session_tenant_fk"
FOREIGN KEY ("sessionId", "workoutId", "personalId")
REFERENCES "workout_sessions"("id", "workoutId", "personalId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workout_set_logs"
ADD CONSTRAINT "workout_set_logs_exercise_tenant_fk"
FOREIGN KEY ("workoutExerciseId", "workoutId", "personalId")
REFERENCES "workout_exercises"("id", "workoutId", "personalId")
ON DELETE RESTRICT ON UPDATE CASCADE;
