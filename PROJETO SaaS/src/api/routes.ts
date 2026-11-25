import { ContractStatus, CycleDuration, ExamStatus, ParcelStatus } from '@prisma/client';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { type AuthenticatedRequest } from './auth';
import { getScopedPrisma, logScopedAccess } from '../db/scoped-prisma';

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_AFTER_DAYS = 30;
const UPCOMING_CONTRACT_DAYS = 30;
const PAGE_SIZE = 50;

const createStudentPaymentSchema = z.object({
  amount: z.number().finite().positive().max(999999999.99)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8),
  paymentMethod: z.enum(['PIX', 'CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'OTHER']),
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidDateOnly),
});
const confirmPaymentParcelSchema = createStudentPaymentSchema.omit({ amount: true });

const WEEKDAY_ORDER = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
const weekdaySchema = z.enum(WEEKDAY_ORDER);
const WEEKDAY_LABELS: Record<z.infer<typeof weekdaySchema>, string> = {
  MONDAY: 'segunda-feira',
  TUESDAY: 'terça-feira',
  WEDNESDAY: 'quarta-feira',
  THURSDAY: 'quinta-feira',
  FRIDAY: 'sexta-feira',
  SATURDAY: 'sábado',
  SUNDAY: 'domingo',
};
const studentScheduleFields = {
  lessonDurationMinutes: z.number().int().min(15).max(240).refine((value) => value % 15 === 0),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(weekdaySchema).min(1).max(7)
    .refine((days) => new Set(days).size === days.length, 'Não repita dias da semana.'),
};

function scheduleEndsBeforeMidnight(schedule: { startTime: string; lessonDurationMinutes: number }) {
  const [hours, minutes] = schedule.startTime.split(':').map(Number);
  return hours * 60 + minutes + schedule.lessonDurationMinutes <= 1440;
}

const studentScheduleSchema = z.object(studentScheduleFields)
  .refine(scheduleEndsBeforeMidnight, 'A aula deve terminar até a meia-noite.');
const createStudentSchema = z.object({
  ...studentScheduleFields,
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  monthlyAmount: z.number().finite().positive().max(999999999.99)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8),
  contractMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]),
}).refine(scheduleEndsBeforeMidnight, 'A aula deve terminar até a meia-noite.');
const setStudentStatusSchema = z.object({ active: z.boolean() });

function isValidDateOnly(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addMonthsClamped(date: Date, months: number) {
  const targetMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1, 12));
  const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0, 12)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDay);
  return new Date(Date.UTC(
    targetMonth.getUTCFullYear(),
    targetMonth.getUTCMonth(),
    day,
    12,
  ));
}

function cycleForMonths(months: 3 | 6 | 12): CycleDuration {
  if (months === 3) return CycleDuration.MONTHS_3;
  if (months === 6) return CycleDuration.MONTHS_6;
  return CycleDuration.MONTHS_12;
}

function startTimeToMinute(startTime: string) {
  const [hours, minutes] = startTime.split(':').map(Number);
  return hours * 60 + minutes;
}

function minuteToStartTime(startMinute: number) {
  return `${String(Math.floor(startMinute / 60)).padStart(2, '0')}:${String(startMinute % 60).padStart(2, '0')}`;
}

function findScheduleConflict(
  existing: Array<{
    dayOfWeek: z.infer<typeof weekdaySchema>;
    startMinute: number;
    student: { name: string; lessonDurationMinutes: number };
  }>,
  proposed: Array<{ dayOfWeek: z.infer<typeof weekdaySchema>; startMinute: number }>,
  durationMinutes: number,
) {
  for (const schedule of proposed) {
    const conflict = existing.find((appointment) =>
      appointment.dayOfWeek === schedule.dayOfWeek
      && schedule.startMinute < appointment.startMinute + appointment.student.lessonDurationMinutes
      && appointment.startMinute < schedule.startMinute + durationMinutes,
    );
    if (conflict) {
      return {
        dayOfWeek: schedule.dayOfWeek,
        studentName: conflict.student.name,
        startMinute: conflict.startMinute,
      };
    }
  }
  return null;
}

function scheduleConflictMessage(conflict: NonNullable<Awaited<ReturnType<typeof findScheduleConflict>>>) {
  return `${conflict.studentName} já tem aula ${WEEKDAY_LABELS[conflict.dayOfWeek]} às ${minuteToStartTime(conflict.startMinute)}. Escolha outro horário.`;
}

const workoutExerciseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sets: z.number().int().min(1).max(100),
  repetitions: z.number().int().min(1).max(1000),
  restSeconds: z.number().int().min(0).max(3600),
});

const workoutDaySchema = z.object({
  dayOfWeek: weekdaySchema,
  exercises: z.array(workoutExerciseSchema).min(1).max(50),
});

const createWorkoutSchema = z.object({
  studentId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
  days: z.array(workoutDaySchema).min(1).max(7),
}).superRefine((workout, context) => {
  const selectedDays = new Set(workout.days.map((day) => day.dayOfWeek));
  if (selectedDays.size !== workout.days.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['days'],
      message: 'Cada dia da semana deve aparecer apenas uma vez.',
    });
  }
  if (workout.days.reduce((total, day) => total + day.exercises.length, 0) > 50) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['days'],
      message: 'O treino pode ter no máximo 50 exercícios.',
    });
  }
});

const setWorkoutStatusSchema = z.object({
  active: z.boolean(),
});

function auth(req: AuthenticatedRequest) {
  if (!req.auth) throw new Error('Authenticated request is missing its auth context');
  return req.auth;
}

function monthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function recentMonths(now: Date, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - count + index + 1, 1);
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      label: new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(date).replace('.', ''),
      receivedCents: 0,
    };
  });
}

function cents(value: { toString(): string }) {
  const result = Number(value.toString());
  if (!Number.isFinite(result)) throw new Error('O banco retornou um valor monetário inválido.');
  return Math.round(result * 100);
}

function amount(value: { toString(): string }) {
  return cents(value) / 100;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function sum(rows: Array<{ amount: { toString(): string } }>) {
  return rows.reduce((total, row) => total + cents(row.amount), 0) / 100;
}

async function getFinanceData(personalId: string, now: Date) {
  const db = getScopedPrisma(personalId);
  const chartMonths = recentMonths(now, 6);
  const firstMonth = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const confirmedWhere = {
    status: ParcelStatus.CONFIRMED,
    confirmedAt: { gte: firstMonth, lt: tomorrow },
  };
  const outstandingWhere = { status: { in: [ParcelStatus.PENDING, ParcelStatus.FAILED] } };

  const [
    confirmedParcels,
    confirmedExtras,
    outstandingParcels,
    outstandingExtras,
    overdueParcels,
    overdueExtras,
    monthlyContracts,
    recentParcels,
    pendingParcels,
    recentExtras,
  ] = await Promise.all([
    db.paymentParcel.findMany({
      where: confirmedWhere,
      select: { amount: true, confirmedAt: true },
    }),
    db.extraPayment.findMany({
      where: confirmedWhere,
      select: { amount: true, confirmedAt: true },
    }),
    db.paymentParcel.findMany({
      where: outstandingWhere,
      select: { amount: true },
    }),
    db.extraPayment.findMany({
      where: outstandingWhere,
      select: { amount: true },
    }),
    db.paymentParcel.count({
      where: { ...outstandingWhere, dueDate: { lt: today } },
    }),
    db.extraPayment.count({
      where: { ...outstandingWhere, dueDate: { lt: today } },
    }),
    db.contract.findMany({
      where: {
        status: ContractStatus.SIGNED,
        startDate: { lte: now },
        endDate: { gte: now },
      },
      select: { monthlyAmount: true },
    }),
    db.paymentParcel.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        amount: true,
        dueDate: true,
        confirmedAt: true,
        status: true,
        paymentMethod: true,
        contract: { select: { student: { select: { name: true } } } },
      },
    }),
    db.paymentParcel.findMany({
      where: { status: { in: [ParcelStatus.PENDING, ParcelStatus.FAILED] } },
      orderBy: { dueDate: 'asc' },
      select: {
        id: true,
        amount: true,
        dueDate: true,
        status: true,
        contract: { select: { student: { select: { name: true } } } },
      },
    }),
    db.extraPayment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        amount: true,
        dueDate: true,
        confirmedAt: true,
        status: true,
        description: true,
        paymentMethod: true,
        student: { select: { name: true } },
      },
    }),
  ]);

  for (const payment of [...confirmedParcels, ...confirmedExtras]) {
    if (!payment.confirmedAt) continue;
    const month = chartMonths.find((item) => item.key === monthKey(payment.confirmedAt!));
    if (month) month.receivedCents += cents(payment.amount);
  }

  const transactions = [
    ...recentParcels.map((payment) => ({
      id: payment.id,
      name: payment.contract.student.name,
      description: 'Parcela de contrato',
      date: payment.confirmedAt ?? payment.dueDate,
      value: amount(payment.amount),
      status: payment.status,
      paymentMethod: payment.paymentMethod,
    })),
    ...recentExtras.map((payment) => ({
      id: payment.id,
      name: payment.student?.name ?? 'Pagamento avulso',
      description: payment.description ?? 'Receita avulsa',
      date: payment.confirmedAt ?? payment.dueDate ?? now,
      value: amount(payment.amount),
      status: payment.status,
      paymentMethod: payment.paymentMethod,
    })),
  ]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, 10)
    .map((payment) => ({
      ...payment,
      date: payment.date.toISOString(),
    }));

  return {
    monthlyRevenue: [...confirmedParcels, ...confirmedExtras]
      .filter((payment) => payment.confirmedAt && monthKey(payment.confirmedAt) === monthKey(now))
      .reduce((total, payment) => total + cents(payment.amount), 0) / 100,
    recurringRevenue:
      monthlyContracts.reduce((total, contract) => total + cents(contract.monthlyAmount), 0) / 100,
    receivable: sum(outstandingParcels) + sum(outstandingExtras),
    overdueCount: overdueParcels + overdueExtras,
    pendingParcels: pendingParcels.map((payment) => ({
      id: payment.id,
      student: payment.contract.student.name,
      dueDate: payment.dueDate.toISOString(),
      amount: amount(payment.amount),
      status: payment.status,
    })),
    chart: chartMonths.map(({ receivedCents, ...month }) => ({
      ...month,
      received: receivedCents / 100,
    })),
    transactions,
  };
}

export function createApiRouter(requirePersonal: RequestHandler) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(requirePersonal);

  router.get('/me', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'READ',
        resource: 'profile',
        ip: req.ip,
      });
      res.json({ user: { name: current.name, email: current.email } });
    } catch (error) {
      next(error);
    }
  });

  router.get('/dashboard', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const db = getScopedPrisma(current.personalId);
      const now = new Date();
      const currentMonth = monthStart(now);
      const thirtyDaysAgo = new Date(now.getTime() - REVIEW_AFTER_DAYS * DAY_MS);
      const contractLimit = new Date(now.getTime() + UPCOMING_CONTRACT_DAYS * DAY_MS);
      const financePromise = getFinanceData(current.personalId, now);

      const [
        studentsTotal,
        studentsActive,
        newStudents,
        activeWorkouts,
        staleWorkouts,
        staleWorkoutItems,
        activeContracts,
        upcomingContracts,
        pendingExams,
        finance,
        scheduleStudents,
      ] = await Promise.all([
        db.student.count({ where: { anonymizedAt: null } }),
        db.student.count({ where: { active: true, anonymizedAt: null } }),
        db.student.count({
          where: { createdAt: { gte: currentMonth }, anonymizedAt: null },
        }),
        db.workout.count({ where: { active: true } }),
        db.workout.count({
          where: { active: true, updatedAt: { lt: thirtyDaysAgo } },
        }),
        db.workout.findMany({
          where: { active: true, updatedAt: { lt: thirtyDaysAgo } },
          orderBy: { updatedAt: 'asc' },
          take: 5,
          select: {
            id: true,
            title: true,
            updatedAt: true,
            student: { select: { name: true } },
          },
        }),
        db.contract.count({
          where: {
            status: ContractStatus.SIGNED,
            startDate: { lte: now },
            endDate: { gte: now },
          },
        }),
        db.contract.findMany({
          where: {
            status: ContractStatus.SIGNED,
            endDate: { gte: now, lte: contractLimit },
          },
          orderBy: { endDate: 'asc' },
          take: 5,
          select: {
            id: true,
            cycle: true,
            endDate: true,
            student: { select: { name: true } },
          },
        }),
        db.exam.count({ where: { status: ExamStatus.PENDING_REVIEW } }),
        financePromise,
        db.student.findMany({
          where: { active: true, anonymizedAt: null },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            lessonDurationMinutes: true,
            schedules: { select: { dayOfWeek: true, startMinute: true } },
          },
        }),
      ]);

      const appointments = scheduleStudents.flatMap((student) => student.schedules.map((schedule) => ({
        studentId: student.id,
        student: student.name,
        dayOfWeek: schedule.dayOfWeek,
        startMinute: schedule.startMinute,
        durationMinutes: student.lessonDurationMinutes,
        weeklyFrequency: student.schedules.length,
      }))).sort((left, right) =>
        WEEKDAY_ORDER.indexOf(left.dayOfWeek) - WEEKDAY_ORDER.indexOf(right.dayOfWeek)
        || left.startMinute - right.startMinute
        || left.student.localeCompare(right.student, 'pt-BR'),
      );
      const unscheduledStudents = scheduleStudents
        .filter((student) => student.schedules.length === 0)
        .map(({ id, name }) => ({ id, name }));

      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'READ',
        resource: 'dashboard',
        purpose: 'gestao_operacional',
        ip: req.ip,
      });
      res.json({
        students: { total: studentsTotal, active: studentsActive, newThisMonth: newStudents },
        workouts: {
          active: activeWorkouts,
          needsReview: staleWorkouts,
          reviewItems: staleWorkoutItems.map((workout) => ({
            id: workout.id,
            title: workout.title,
            student: workout.student.name,
            updatedAt: workout.updatedAt.toISOString(),
          })),
        },
        contracts: {
          active: activeContracts,
          upcoming: upcomingContracts.map((contract) => ({
            id: contract.id,
            student: contract.student.name,
            cycle: contract.cycle,
            endDate: contract.endDate.toISOString(),
          })),
        },
        pendingExams,
        finance,
        schedule: { appointments, unscheduledStudents },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/students', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const requestedPage = Number(req.query.page);
      const page =
        Number.isSafeInteger(requestedPage) && requestedPage > 0
          ? Math.min(requestedPage, 1_000_000)
          : 1;
      const status = req.query.status;
      const active =
        status === 'Ativo' ? true : status === 'Inativo' ? false : undefined;
      const db = getScopedPrisma(current.personalId);
      const where = {
        anonymizedAt: null,
        ...(active === undefined ? {} : { active }),
      };
      const [total, allCount, items] = await Promise.all([
        db.student.count({ where }),
        db.student.count({ where: { anonymizedAt: null } }),
        db.student.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          select: {
            id: true,
            name: true,
            email: true,
            active: true,
            createdAt: true,
            contracts: {
              orderBy: { startDate: 'desc' },
              take: 1,
              select: { cycle: true },
            },
          },
        }),
      ]);
      const currentMonth = monthStart(new Date());
      const [activeCount, newThisMonth] = await Promise.all([
        db.student.count({ where: { active: true, anonymizedAt: null } }),
        db.student.count({
          where: { createdAt: { gte: currentMonth }, anonymizedAt: null },
        }),
      ]);
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'READ',
        resource: 'students',
        ip: req.ip,
      });
      res.json({
        items: items.map((student) => ({
          id: student.id,
          name: student.name,
          email: student.email,
          active: student.active,
          createdAt: student.createdAt.toISOString(),
          plan: student.contracts[0]?.cycle ?? null,
        })),
        total,
        allCount,
        activeCount,
        newThisMonth,
        page,
        pageSize: PAGE_SIZE,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/students', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const parsed = createStudentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Informe nome, e-mail, valor mensal, duração do contrato e uma agenda válida, com ao menos um dia.' });
        return;
      }
      const db = getScopedPrisma(current.personalId);
      const startMinute = startTimeToMinute(parsed.data.startTime);
      const proposed = parsed.data.days.map((dayOfWeek) => ({ dayOfWeek, startMinute }));
      const currentDate = new Date();
      const contractStartDate = new Date(Date.UTC(
        currentDate.getUTCFullYear(),
        currentDate.getUTCMonth(),
        currentDate.getUTCDate(),
        12,
      ));
      const contractEndDate = addMonthsClamped(contractStartDate, parsed.data.contractMonths);
      contractEndDate.setUTCDate(contractEndDate.getUTCDate() - 1);
      const monthlyAmountCents = Math.round(parsed.data.monthlyAmount * 100);
      const monthlyAmount = (monthlyAmountCents / 100).toFixed(2);
      const result = await db.$transaction(async (tx) => {
        const existing = await tx.studentSchedule.findMany({
          where: {
            dayOfWeek: { in: parsed.data.days },
            student: { is: { active: true, anonymizedAt: null } },
          },
          select: {
            dayOfWeek: true,
            startMinute: true,
            student: { select: { name: true, lessonDurationMinutes: true } },
          },
        });
        const conflict = findScheduleConflict(existing, proposed, parsed.data.lessonDurationMinutes);
        if (conflict) return { conflict, student: null };

        const student = await tx.student.create({
          data: {
            personalId: current.personalId,
            name: parsed.data.name,
            email: parsed.data.email,
            lessonDurationMinutes: parsed.data.lessonDurationMinutes,
          },
        });
        await tx.studentSchedule.createMany({
          data: parsed.data.days.map((dayOfWeek) => ({
            personalId: current.personalId,
            studentId: student.id,
            dayOfWeek,
            startMinute,
          })),
        });
        const contract = await tx.contract.create({
          data: {
            personalId: current.personalId,
            studentId: student.id,
            cycle: cycleForMonths(parsed.data.contractMonths),
            status: ContractStatus.SIGNED,
            totalAmount: (monthlyAmountCents * parsed.data.contractMonths / 100).toFixed(2),
            monthlyAmount,
            startDate: contractStartDate,
            endDate: contractEndDate,
            signedAt: contractStartDate,
          },
          select: { id: true },
        });
        await tx.paymentParcel.createMany({
          data: Array.from({ length: parsed.data.contractMonths }, (_, month) => {
            const dueDate = addMonthsClamped(contractStartDate, month);
            return {
              personalId: current.personalId,
              contractId: contract.id,
              dueDate,
              amount: monthlyAmount,
            };
          }),
        });
        return { conflict: null, student };
      });
      if (result.conflict) {
        res.status(409).json({ error: scheduleConflictMessage(result.conflict) });
        return;
      }
      const student = result.student;
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'WRITE',
        resource: 'student',
        resourceId: student.id,
        ip: req.ip,
      });
      res.status(201).json({
        id: student.id,
        name: student.name,
        email: student.email,
        active: student.active,
        lessonDurationMinutes: student.lessonDurationMinutes,
        weeklyFrequency: parsed.data.days.length,
        schedules: parsed.data.days.map((dayOfWeek) => ({ dayOfWeek, startTime: parsed.data.startTime })),
        createdAt: student.createdAt.toISOString(),
        plan: cycleForMonths(parsed.data.contractMonths),
        contract: {
          months: parsed.data.contractMonths,
          monthlyAmount: Number(monthlyAmount),
          totalAmount: monthlyAmountCents * parsed.data.contractMonths / 100,
          startDate: contractStartDate.toISOString(),
          endDate: contractEndDate.toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/students/options', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      const db = getScopedPrisma(current.personalId);
      const where = {
        active: true,
        anonymizedAt: null,
        ...(query
          ? {
              OR: [
                { name: { contains: query, mode: 'insensitive' as const } },
                { email: { contains: query, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };
      const [students, total] = await Promise.all([
        db.student.findMany({
          where,
          orderBy: { name: 'asc' },
          take: PAGE_SIZE,
          select: { id: true, name: true, email: true },
        }),
        db.student.count({ where }),
      ]);
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'READ',
        resource: 'students.options',
        ip: req.ip,
      });
      res.json({
        items: students,
        hasMore: total > students.length,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/students/:studentId', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const studentId = req.params.studentId;
      if (typeof studentId !== 'string') {
        res.status(400).json({ error: 'Identificador de aluno inválido.' });
        return;
      }
      const db = getScopedPrisma(current.personalId);
      const student = await db.student.findFirst({
        where: { id: studentId, anonymizedAt: null },
        select: {
          id: true,
          name: true,
          email: true,
          active: true,
          createdAt: true,
          lessonDurationMinutes: true,
          schedules: { select: { dayOfWeek: true, startMinute: true }, orderBy: { dayOfWeek: 'asc' } },
        },
      });
      if (!student) {
        res.status(404).json({ error: 'Aluno não encontrado.' });
        return;
      }
      const payments = await db.extraPayment.findMany({
        where: { studentId: student.id },
        orderBy: [{ confirmedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          amount: true,
          status: true,
          paymentMethod: true,
          dueDate: true,
          confirmedAt: true,
          createdAt: true,
        },
      });
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'READ',
        resource: 'student.payments',
        resourceId: student.id,
        ip: req.ip,
      });
      res.json({
        student: {
          ...student,
          createdAt: student.createdAt.toISOString(),
          schedules: student.schedules.map((schedule) => ({
            dayOfWeek: schedule.dayOfWeek,
            startTime: minuteToStartTime(schedule.startMinute),
          })),
          weeklyFrequency: student.schedules.length,
        },
        payments: payments.map((payment) => ({
          id: payment.id,
          amount: amount(payment.amount),
          status: payment.status,
          paymentMethod: payment.paymentMethod,
          paidAt: (payment.confirmedAt ?? payment.dueDate ?? payment.createdAt).toISOString(),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/students/:studentId/schedule', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const studentId = req.params.studentId;
      if (typeof studentId !== 'string') {
        res.status(400).json({ error: 'Identificador de aluno inválido.' });
        return;
      }
      const parsed = studentScheduleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Informe duração, horário e ao menos um dia válido para a aula.' });
        return;
      }

      const db = getScopedPrisma(current.personalId);
      const result = await db.$transaction(async (tx) => {
        const student = await tx.student.findFirst({
          where: { id: studentId, anonymizedAt: null },
          select: { id: true },
        });
        if (!student) return { student: null, conflict: null };
        const startMinute = startTimeToMinute(parsed.data.startTime);
        const proposed = parsed.data.days.map((dayOfWeek) => ({ dayOfWeek, startMinute }));
        const existing = await tx.studentSchedule.findMany({
          where: {
            dayOfWeek: { in: parsed.data.days },
            student: { is: { active: true, anonymizedAt: null } },
            studentId: { not: student.id },
          },
          select: {
            dayOfWeek: true,
            startMinute: true,
            student: { select: { name: true, lessonDurationMinutes: true } },
          },
        });
        const conflict = findScheduleConflict(existing, proposed, parsed.data.lessonDurationMinutes);
        if (conflict) return { student: null, conflict };

        await tx.student.update({
          where: { id: student.id },
          data: { lessonDurationMinutes: parsed.data.lessonDurationMinutes },
        });
        await tx.studentSchedule.deleteMany({ where: { studentId: student.id } });
        await tx.studentSchedule.createMany({
          data: parsed.data.days.map((dayOfWeek) => ({
            personalId: current.personalId,
            studentId: student.id,
            dayOfWeek,
            startMinute,
          })),
        });
        return { student, conflict: null };
      });

      if (result.conflict) {
        res.status(409).json({ error: scheduleConflictMessage(result.conflict) });
        return;
      }
      if (!result.student) {
        res.status(404).json({ error: 'Aluno não encontrado.' });
        return;
      }
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'WRITE',
        resource: 'student.schedule',
        resourceId: studentId,
        ip: req.ip,
      });
      res.json({
        id: studentId,
        lessonDurationMinutes: parsed.data.lessonDurationMinutes,
        weeklyFrequency: parsed.data.days.length,
        schedules: parsed.data.days.map((dayOfWeek) => ({
          dayOfWeek,
          startTime: parsed.data.startTime,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/students/:studentId', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const studentId = req.params.studentId;
      if (typeof studentId !== 'string') {
        res.status(400).json({ error: 'Identificador de aluno inválido.' });
        return;
      }
      const parsed = setStudentStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Informe se o aluno deve ficar ativo ou inativo.' });
        return;
      }
      const db = getScopedPrisma(current.personalId);
      const result = await db.$transaction(async (tx) => {
        const student = await tx.student.findFirst({
          where: { id: studentId, anonymizedAt: null },
          select: {
            id: true,
            schedules: { select: { dayOfWeek: true, startMinute: true } },
            lessonDurationMinutes: true,
          },
        });
        if (!student) return { student: null, conflict: null };
        if (parsed.data.active) {
          const existing = await tx.studentSchedule.findMany({
            where: {
              dayOfWeek: { in: student.schedules.map((schedule) => schedule.dayOfWeek) },
              student: { is: { active: true, anonymizedAt: null } },
              studentId: { not: student.id },
            },
            select: {
              dayOfWeek: true,
              startMinute: true,
              student: { select: { name: true, lessonDurationMinutes: true } },
            },
          });
          const conflict = findScheduleConflict(existing, student.schedules, student.lessonDurationMinutes);
          if (conflict) return { student: null, conflict };
        }
        const updated = await tx.student.update({
          where: { id: student.id },
          data: { active: parsed.data.active },
          select: { id: true, active: true },
        });
        if (!parsed.data.active) {
          await tx.workout.updateMany({
            where: { personalId: current.personalId, studentId: student.id, active: true },
            data: { active: false },
          });
        }
        return { student: updated, conflict: null };
      });
      if (result.conflict) {
        res.status(409).json({ error: scheduleConflictMessage(result.conflict) });
        return;
      }
      if (!result.student) {
        res.status(404).json({ error: 'Aluno não encontrado.' });
        return;
      }
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'WRITE',
        resource: 'student.status',
        resourceId: studentId,
        ip: req.ip,
      });
      res.json(result.student);
    } catch (error) {
      next(error);
    }
  });

  router.post('/students/:studentId/payments', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const studentId = req.params.studentId;
      if (typeof studentId !== 'string') {
        res.status(400).json({ error: 'Identificador de aluno inválido.' });
        return;
      }
      const parsed = createStudentPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Informe um valor válido, a forma e a data do pagamento.' });
        return;
      }
      const db = getScopedPrisma(current.personalId);
      const student = await db.student.findFirst({
        where: { id: studentId, anonymizedAt: null },
        select: { id: true },
      });
      if (!student) {
        res.status(404).json({ error: 'Aluno não encontrado.' });
        return;
      }
      const paidAt = new Date(`${parsed.data.paidAt}T12:00:00.000Z`);
      const payment = await db.extraPayment.create({
        data: {
          personalId: current.personalId,
          studentId: student.id,
          amount: parsed.data.amount.toFixed(2),
          paymentMethod: parsed.data.paymentMethod,
          dueDate: paidAt,
          confirmedAt: paidAt,
          status: ParcelStatus.CONFIRMED,
        },
      });
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'WRITE',
        resource: 'student.payment',
        resourceId: payment.id,
        ip: req.ip,
      });
      res.status(201).json({
        id: payment.id,
        amount: amount(payment.amount),
        paymentMethod: payment.paymentMethod,
        status: payment.status,
        paidAt: paidAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/workouts', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const db = getScopedPrisma(current.personalId);
      const now = new Date();
      const staleBefore = new Date(now.getTime() - REVIEW_AFTER_DAYS * DAY_MS);
      const [items, total, activeCount, recentlyUpdated, needsReview] = await Promise.all([
        db.workout.findMany({
          orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
          take: 100,
          select: {
            id: true,
            title: true,
            description: true,
            active: true,
            updatedAt: true,
            student: { select: { id: true, name: true } },
            exercises: {
              orderBy: [{ dayOfWeek: 'asc' }, { position: 'asc' }],
              select: {
                id: true,
                dayOfWeek: true,
                name: true,
                sets: true,
                repetitions: true,
                restSeconds: true,
              },
            },
          },
        }),
        db.workout.count(),
        db.workout.count({ where: { active: true } }),
        db.workout.count({ where: { active: true, updatedAt: { gte: staleBefore } } }),
        db.workout.count({ where: { active: true, updatedAt: { lt: staleBefore } } }),
      ]);
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'READ',
        resource: 'workouts',
        ip: req.ip,
      });
      res.json({
        items: items.map((workout) => ({
          ...workout,
          updatedAt: workout.updatedAt.toISOString(),
        })),
        total,
        activeCount,
        inactiveCount: total - activeCount,
        active: recentlyUpdated,
        needsReview,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/workouts', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const parsed = createWorkoutSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Informe o aluno, o nome do treino e pelo menos um dia com exercícios válidos.' });
        return;
      }

      const db = getScopedPrisma(current.personalId);
      const student = await db.student.findFirst({
        where: { id: parsed.data.studentId, active: true, anonymizedAt: null },
        select: { id: true },
      });
      if (!student) {
        res.status(404).json({ error: 'Aluno ativo não encontrado.' });
        return;
      }

      const workout = await db.$transaction(async (tx) => {
        await tx.workout.updateMany({
          where: { personalId: current.personalId, studentId: student.id, active: true },
          data: { active: false },
        });
        return tx.workout.create({
          data: {
            personalId: current.personalId,
            studentId: student.id,
            title: parsed.data.title,
            active: true,
            exercises: {
              create: parsed.data.days.flatMap(({ dayOfWeek, exercises }) => exercises.map((exercise, position) => ({
                ...exercise,
                dayOfWeek,
                position,
              }))),
            },
          },
          select: {
            id: true,
            title: true,
            active: true,
            updatedAt: true,
            student: { select: { id: true, name: true } },
            exercises: {
              orderBy: [{ dayOfWeek: 'asc' }, { position: 'asc' }],
              select: {
                id: true,
                dayOfWeek: true,
                name: true,
                sets: true,
                repetitions: true,
                restSeconds: true,
              },
            },
          },
        });
      });

      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'WRITE',
        resource: 'workout',
        resourceId: workout.id,
        ip: req.ip,
      });
      res.status(201).json({
        ...workout,
        updatedAt: workout.updatedAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/workouts/:workoutId', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const workoutId = req.params.workoutId;
      if (typeof workoutId !== 'string') {
        res.status(400).json({ error: 'Identificador de treino inválido.' });
        return;
      }
      const parsed = setWorkoutStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Informe se o treino deve ficar ativo ou inativo.' });
        return;
      }

      const db = getScopedPrisma(current.personalId);
      const workout = await db.$transaction(async (tx) => {
        const existing = await tx.workout.findFirst({
          where: { id: workoutId, personalId: current.personalId },
          select: { id: true, studentId: true },
        });
        if (!existing) return null;

        if (parsed.data.active) {
          await tx.workout.updateMany({
            where: {
              personalId: current.personalId,
              studentId: existing.studentId,
              active: true,
              NOT: { id: existing.id },
            },
            data: { active: false },
          });
        }

        return tx.workout.update({
          where: { id: existing.id },
          data: { active: parsed.data.active },
          select: { id: true, title: true, active: true },
        });
      });
      if (!workout) {
        res.status(404).json({ error: 'Treino não encontrado.' });
        return;
      }

      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'WRITE',
        resource: 'workout',
        resourceId: workout.id,
        ip: req.ip,
      });
      res.json(workout);
    } catch (error) {
      next(error);
    }
  });

  router.get('/finance', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const finance = await getFinanceData(current.personalId, new Date());
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'READ',
        resource: 'finance',
        purpose: 'gestao_financeira',
        ip: req.ip,
      });
      res.json(finance);
    } catch (error) {
      next(error);
    }
  });

  router.post('/finance/parcels/:parcelId/confirm', async (req: AuthenticatedRequest, res, next) => {
    try {
      const current = auth(req);
      const parcelId = req.params.parcelId;
      if (typeof parcelId !== 'string') {
        res.status(400).json({ error: 'Identificador de parcela inválido.' });
        return;
      }
      const parsed = confirmPaymentParcelSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Informe uma forma de pagamento e uma data válida.' });
        return;
      }
      const db = getScopedPrisma(current.personalId);
      const parcel = await db.paymentParcel.findFirst({
        where: { id: parcelId },
        select: { id: true, status: true },
      });
      if (!parcel) {
        res.status(404).json({ error: 'Parcela não encontrada.' });
        return;
      }
      if (parcel.status !== ParcelStatus.PENDING && parcel.status !== ParcelStatus.FAILED) {
        res.status(409).json({ error: 'Esta parcela não está pendente de confirmação.' });
        return;
      }
      const confirmedAt = new Date(`${parsed.data.paidAt}T12:00:00.000Z`);
      const result = await db.paymentParcel.updateMany({
        where: { id: parcel.id, status: { in: [ParcelStatus.PENDING, ParcelStatus.FAILED] } },
        data: {
          status: ParcelStatus.CONFIRMED,
          confirmedAt,
          paymentMethod: parsed.data.paymentMethod,
        },
      });
      if (result.count !== 1) {
        res.status(409).json({ error: 'Esta parcela já foi atualizada. Recarregue o Financeiro.' });
        return;
      }
      await logScopedAccess({
        userId: current.userId,
        personalId: current.personalId,
        action: 'WRITE',
        resource: 'finance.payment-parcel',
        resourceId: parcel.id,
        ip: req.ip,
      });
      res.json({
        id: parcel.id,
        status: ParcelStatus.CONFIRMED,
        confirmedAt: confirmedAt.toISOString(),
        paymentMethod: parsed.data.paymentMethod,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
