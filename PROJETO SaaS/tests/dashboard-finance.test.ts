import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthenticatedRequest } from '../src/api/auth';
import { createApiRouter } from '../src/api/routes';

const mocks = vi.hoisted(() => ({
  getScopedPrisma: vi.fn(),
  logScopedAccess: vi.fn(),
}));

vi.mock('../src/db/scoped-prisma', () => mocks);

const confirmedPayment = {
  amount: { toString: () => '275.50' },
  confirmedAt: new Date('2026-11-25T12:00:00.000Z'),
};

const db = {
  student: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
  workout: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
  contract: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
  exam: { count: vi.fn().mockResolvedValue(0) },
  paymentParcel: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
  extraPayment: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn() },
};

function createApp() {
  const app = express();
  const requirePersonal: RequestHandler = (req, _res, next) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      personalId: 'personal-1',
      role: 'PERSONAL',
      name: 'Personal',
      email: 'personal@example.com',
    };
    next();
  };
  app.use('/api', createApiRouter(requirePersonal));
  return app;
}

describe('receita recebida no dashboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T09:00:00.000Z'));
    vi.clearAllMocks();
    mocks.getScopedPrisma.mockReturnValue(db);
    db.extraPayment.findMany
      .mockResolvedValueOnce([confirmedPayment])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inclui pagamentos confirmados de alunos na receita mensal e no gráfico', async () => {
    const response = await request(createApp()).get('/api/dashboard');

    expect(response.status).toBe(200);
    expect(response.body.finance.monthlyRevenue).toBe(275.5);
    expect(response.body.finance.chart.at(-1)).toMatchObject({
      key: '2026-11',
      received: 275.5,
    });
  });

  it('organiza a agenda por dia e horário e lista alunos sem horário', async () => {
    db.student.findMany.mockResolvedValueOnce([
      {
        id: 'student-a',
        name: 'Ana Silva',
        lessonDurationMinutes: 60,
        schedules: [
          { dayOfWeek: 'MONDAY', startMinute: 480 },
          { dayOfWeek: 'WEDNESDAY', startMinute: 480 },
        ],
      },
      {
        id: 'student-b',
        name: 'Bruna Costa',
        lessonDurationMinutes: 60,
        schedules: [],
      },
      {
        id: 'student-c',
        name: 'Carla Lima',
        lessonDurationMinutes: 90,
        schedules: [{ dayOfWeek: 'MONDAY', startMinute: 540 }],
      },
    ]);

    const response = await request(createApp()).get('/api/dashboard');

    expect(response.status).toBe(200);
    expect(response.body.schedule.appointments).toEqual([
      {
        studentId: 'student-a',
        student: 'Ana Silva',
        dayOfWeek: 'MONDAY',
        startMinute: 480,
        durationMinutes: 60,
        weeklyFrequency: 2,
      },
      {
        studentId: 'student-c',
        student: 'Carla Lima',
        dayOfWeek: 'MONDAY',
        startMinute: 540,
        durationMinutes: 90,
        weeklyFrequency: 1,
      },
      {
        studentId: 'student-a',
        student: 'Ana Silva',
        dayOfWeek: 'WEDNESDAY',
        startMinute: 480,
        durationMinutes: 60,
        weeklyFrequency: 2,
      },
    ]);
    expect(response.body.schedule.unscheduledStudents).toEqual([
      { id: 'student-b', name: 'Bruna Costa' },
    ]);
  });
});
