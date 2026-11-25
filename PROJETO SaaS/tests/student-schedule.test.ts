import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthenticatedRequest } from '../src/api/auth';
import { createApiRouter } from '../src/api/routes';

const mocks = vi.hoisted(() => ({
  getScopedPrisma: vi.fn(),
  logScopedAccess: vi.fn(),
}));

vi.mock('../src/db/scoped-prisma', () => mocks);

const createdAt = new Date('2026-11-25T12:00:00.000Z');
const db = {
  $transaction: vi.fn(),
  student: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  studentSchedule: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  workout: { updateMany: vi.fn() },
};

function createApp() {
  const app = express();
  app.use(express.json());
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

const scheduleInput = {
  lessonDurationMinutes: 60,
  startTime: '08:00',
  days: ['MONDAY', 'WEDNESDAY', 'FRIDAY'],
};

describe('agenda semanal de alunos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getScopedPrisma.mockReturnValue(db);
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.student.create.mockResolvedValue({
      id: 'student-1',
      name: 'Ana Silva',
      email: 'ana@example.com',
      active: true,
      lessonDurationMinutes: 60,
      createdAt,
    });
    db.student.findFirst.mockResolvedValue({ id: 'student-1' });
    db.student.update.mockResolvedValue({ id: 'student-1', lessonDurationMinutes: 90 });
    db.studentSchedule.findMany.mockResolvedValue([]);
    db.studentSchedule.createMany.mockResolvedValue({ count: 3 });
    db.studentSchedule.deleteMany.mockResolvedValue({ count: 0 });
  });

  it('cria aluno e agenda semanal em uma única transação', async () => {
    const response = await request(createApp())
      .post('/api/students')
      .send({ name: 'Ana Silva', email: 'ana@example.com', ...scheduleInput });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: 'student-1',
      lessonDurationMinutes: 60,
      weeklyFrequency: 3,
      schedules: [
        { dayOfWeek: 'MONDAY', startTime: '08:00' },
        { dayOfWeek: 'WEDNESDAY', startTime: '08:00' },
        { dayOfWeek: 'FRIDAY', startTime: '08:00' },
      ],
    });
    expect(db.student.create).toHaveBeenCalledWith({
      data: {
        personalId: 'personal-1',
        name: 'Ana Silva',
        email: 'ana@example.com',
        lessonDurationMinutes: 60,
      },
    });
    expect(db.studentSchedule.createMany).toHaveBeenCalledWith({
      data: ['MONDAY', 'WEDNESDAY', 'FRIDAY'].map((dayOfWeek) => ({
        personalId: 'personal-1',
        studentId: 'student-1',
        dayOfWeek,
        startMinute: 480,
      })),
    });
  });

  it('bloqueia horários sobrepostos com alunos ativos', async () => {
    db.studentSchedule.findMany.mockResolvedValue([{
      dayOfWeek: 'MONDAY',
      startMinute: 510,
      student: { name: 'Bruna Costa', lessonDurationMinutes: 60 },
    }]);

    const response = await request(createApp())
      .post('/api/students')
      .send({ name: 'Ana Silva', email: 'ana@example.com', ...scheduleInput });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('Bruna Costa');
    expect(db.student.create).not.toHaveBeenCalled();
    expect(db.studentSchedule.createMany).not.toHaveBeenCalled();
  });

  it('permite aulas consecutivas sem sobreposição', async () => {
    db.studentSchedule.findMany.mockResolvedValue([{
      dayOfWeek: 'MONDAY',
      startMinute: 540,
      student: { name: 'Bruna Costa', lessonDurationMinutes: 60 },
    }]);

    const response = await request(createApp())
      .post('/api/students')
      .send({ name: 'Ana Silva', email: 'ana@example.com', ...scheduleInput });

    expect(response.status).toBe(201);
    expect(db.studentSchedule.createMany).toHaveBeenCalledOnce();
  });

  it('rejeita frequência vazia, dias duplicados e término após meia-noite', async () => {
    const noDays = await request(createApp())
      .post('/api/students')
      .send({ name: 'Ana Silva', email: 'ana@example.com', ...scheduleInput, days: [] });
    const duplicateDays = await request(createApp())
      .post('/api/students')
      .send({ name: 'Ana Silva', email: 'ana@example.com', ...scheduleInput, days: ['MONDAY', 'MONDAY'] });
    const overnight = await request(createApp())
      .post('/api/students')
      .send({
        name: 'Ana Silva',
        email: 'ana@example.com',
        ...scheduleInput,
        startTime: '23:30',
      });

    expect(noDays.status).toBe(400);
    expect(duplicateDays.status).toBe(400);
    expect(overnight.status).toBe(400);
    expect(db.student.create).not.toHaveBeenCalled();
  });

  it('atualiza duração e dias sem permitir conflito', async () => {
    const response = await request(createApp())
      .patch('/api/students/student-1/schedule')
      .send({ ...scheduleInput, lessonDurationMinutes: 90, days: ['TUESDAY'] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: 'student-1',
      lessonDurationMinutes: 90,
      weeklyFrequency: 1,
      schedules: [{ dayOfWeek: 'TUESDAY', startTime: '08:00' }],
    });
    expect(db.student.update).toHaveBeenCalledWith({
      where: { id: 'student-1' },
      data: { lessonDurationMinutes: 90 },
    });
    expect(db.studentSchedule.deleteMany).toHaveBeenCalledWith({
      where: { studentId: 'student-1' },
    });
    expect(db.studentSchedule.createMany).toHaveBeenCalledWith({
      data: [{
        personalId: 'personal-1',
        studentId: 'student-1',
        dayOfWeek: 'TUESDAY',
        startMinute: 480,
      }],
    });
  });

  it('impede reativar aluno quando a agenda dele conflita', async () => {
    db.student.findFirst.mockResolvedValue({
      id: 'student-1',
      lessonDurationMinutes: 60,
      schedules: [{ dayOfWeek: 'MONDAY', startMinute: 480 }],
    });
    db.studentSchedule.findMany.mockResolvedValue([{
      dayOfWeek: 'MONDAY',
      startMinute: 510,
      student: { name: 'Bruna Costa', lessonDurationMinutes: 60 },
    }]);

    const response = await request(createApp())
      .patch('/api/students/student-1')
      .send({ active: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('Bruna Costa');
    expect(db.student.update).not.toHaveBeenCalled();
  });
});
