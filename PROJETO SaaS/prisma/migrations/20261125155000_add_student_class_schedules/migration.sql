ALTER TABLE "students"
ADD COLUMN "lessonDurationMinutes" INTEGER NOT NULL DEFAULT 60;

ALTER TABLE "students"
ADD CONSTRAINT "students_lesson_duration_check"
CHECK ("lessonDurationMinutes" BETWEEN 15 AND 240 AND "lessonDurationMinutes" % 15 = 0);

CREATE TABLE "student_schedules" (
    "id" TEXT NOT NULL,
    "personalId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "dayOfWeek" "Weekday" NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "student_schedules_start_minute_check" CHECK ("startMinute" >= 0 AND "startMinute" < 1440)
);

CREATE UNIQUE INDEX "student_schedules_personalId_studentId_dayOfWeek_key"
ON "student_schedules"("personalId", "studentId", "dayOfWeek");

CREATE INDEX "student_schedules_personalId_dayOfWeek_startMinute_idx"
ON "student_schedules"("personalId", "dayOfWeek", "startMinute");

ALTER TABLE "student_schedules"
ADD CONSTRAINT "student_schedules_personalId_fkey"
FOREIGN KEY ("personalId") REFERENCES "personals"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "student_schedules"
ADD CONSTRAINT "student_schedules_student_tenant_fk"
FOREIGN KEY ("studentId", "personalId") REFERENCES "students"("id", "personalId")
ON DELETE RESTRICT ON UPDATE CASCADE;
