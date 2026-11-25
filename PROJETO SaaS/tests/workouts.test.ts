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

const db = {
  $transaction: vi.fn(),
  student: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  workout: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
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

describe('treinos dos alunos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getScopedPrisma.mockReturnValue(db);
    db.$transaction.mockImplementation(async (operation) => operation(db));
    db.student.findFirst.mockResolvedValue({ id: 'student-1' });
    db.workout.updateMany.mockResolvedValue({ count: 1 });
    db.workout.create.mockResolvedValue({
      id: 'workout-new',
      title: 'Treino A',
      active: true,
      updatedAt: new Date('2026-11-25T12:00:00.000Z'),
      student: { id: 'student-1', name: 'Ana' },
      exercises: [
        {
          id: 'exercise-1',
          dayOfWeek: 'MONDAY',
          name: 'Agachamento',
          sets: 3,
          repetitions: 12,
          restSeconds: 60,
        },
        {
          id: 'exercise-2',
          dayOfWeek: 'MONDAY',
          name: 'Leg press',
          sets: 4,
          repetitions: 10,
          restSeconds: 60,
        },
        {
          id: 'exercise-3',
          dayOfWeek: 'WEDNESDAY',
          name: 'Passada',
          sets: 3,
          repetitions: 12,
          restSeconds: 45,
        },
      ],
    });
  });

  it('cria plano semanal ativo e desativa o plano ativo anterior do aluno', async () => {
    const response = await request(createApp())
      .post('/api/workouts')
      .send({
        studentId: 'student-1',
        title: 'Treino A',
        days: [
          {
            dayOfWeek: 'MONDAY',
            exercises: [
              { name: 'Agachamento', sets: 3, repetitions: 12, restSeconds: 60 },
              { name: 'Leg press', sets: 4, repetitions: 10, restSeconds: 60 },
            ],
          },
          {
            dayOfWeek: 'WEDNESDAY',
            exercises: [{ name: 'Passada', sets: 3, repetitions: 12, restSeconds: 45 }],
          },
        ],
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: 'workout-new',
      title: 'Treino A',
      active: true,
      student: { id: 'student-1', name: 'Ana' },
      exercises: [
        { dayOfWeek: 'MONDAY', name: 'Agachamento', sets: 3, repetitions: 12, restSeconds: 60 },
        { dayOfWeek: 'MONDAY', name: 'Leg press', sets: 4, repetitions: 10, restSeconds: 60 },
        { dayOfWeek: 'WEDNESDAY', name: 'Passada', sets: 3, repetitions: 12, restSeconds: 45 },
      ],
    });
    expect(db.workout.updateMany).toHaveBeenCalledWith({
      where: { personalId: 'personal-1', studentId: 'student-1', active: true },
      data: { active: false },
    });
    expect(db.workout.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        personalId: 'personal-1',
        studentId: 'student-1',
        title: 'Treino A',
        active: true,
        exercises: {
          create: [{
            name: 'Agachamento',
            dayOfWeek: 'MONDAY',
            sets: 3,
            repetitions: 12,
            restSeconds: 60,
            position: 0,
          }, {
            name: 'Leg press',
            dayOfWeek: 'MONDAY',
            sets: 4,
            repetitions: 10,
            restSeconds: 60,
            position: 1,
          }, {
            name: 'Passada',
            dayOfWeek: 'WEDNESDAY',
            sets: 3,
            repetitions: 12,
            restSeconds: 45,
            position: 0,
          }],
        },
      }),
    }));
    expect(db.workout.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(db.workout.create.mock.invocationCallOrder[0]);
  });

  it('rejeita treinos sem dia ou sem exercício válido', async () => {
    const response = await request(createApp())
      .post('/api/workouts')
      .send({ studentId: 'student-1', title: 'Treino inválido', days: [] });

    expect(response.status).toBe(400);
    expect(db.workout.create).not.toHaveBeenCalled();
    expect(db.workout.updateMany).not.toHaveBeenCalled();
  });

  it('rejeita dias repetidos e conjuntos sem exercícios', async () => {
    const repeatedDay = await request(createApp())
      .post('/api/workouts')
      .send({
        studentId: 'student-1',
        title: 'Treino inválido',
        days: [
          { dayOfWeek: 'MONDAY', exercises: [{ name: 'Agachamento', sets: 3, repetitions: 12, restSeconds: 60 }] },
          { dayOfWeek: 'MONDAY', exercises: [{ name: 'Leg press', sets: 3, repetitions: 12, restSeconds: 60 }] },
        ],
      });
    const emptyDay = await request(createApp())
      .post('/api/workouts')
      .send({ studentId: 'student-1', title: 'Treino inválido', days: [{ dayOfWeek: 'TUESDAY', exercises: [] }] });

    expect(repeatedDay.status).toBe(400);
    expect(emptyDay.status).toBe(400);
    expect(db.workout.create).not.toHaveBeenCalled();
    expect(db.workout.updateMany).not.toHaveBeenCalled();
  });

  it('não cria treino para aluno de outro tenant ou inativo', async () => {
    db.student.findFirst.mockResolvedValue(null);

    const response = await request(createApp())
      .post('/api/workouts')
      .send({
        studentId: 'foreign-student',
        title: 'Treino A',
        days: [{
          dayOfWeek: 'MONDAY',
          exercises: [{ name: 'Agachamento', sets: 3, repetitions: 12, restSeconds: 60 }],
        }],
      });

    expect(response.status).toBe(404);
    expect(db.workout.create).not.toHaveBeenCalled();
    expect(db.workout.updateMany).not.toHaveBeenCalled();
  });

  it('lista treinos ativos e inativos com os exercícios para manter o histórico', async () => {
    const updatedAt = new Date('2026-11-25T12:00:00.000Z');
    db.workout.findMany.mockResolvedValue([
      {
        id: 'workout-active',
        title: 'Treino atual',
        description: null,
        active: true,
        updatedAt,
        student: { id: 'student-1', name: 'Ana' },
        exercises: [{
          id: 'exercise-1',
          dayOfWeek: 'MONDAY',
          name: 'Agachamento',
          sets: 3,
          repetitions: 12,
          restSeconds: 60,
        }],
      },
      {
        id: 'workout-inactive',
        title: 'Treino anterior',
        description: null,
        active: false,
        updatedAt,
        student: { id: 'student-1', name: 'Ana' },
        exercises: [],
      },
    ]);
    db.workout.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    const response = await request(createApp()).get('/api/workouts');

    expect(response.status).toBe(200);
    expect(response.body.items.map((item: { active: boolean }) => item.active)).toEqual([true, false]);
    expect(response.body.items[0].exercises[0]).toMatchObject({
      name: 'Agachamento',
      dayOfWeek: 'MONDAY',
      sets: 3,
      repetitions: 12,
      restSeconds: 60,
    });
    expect(response.body).toMatchObject({ total: 2, activeCount: 1, inactiveCount: 1 });
    expect(db.workout.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
    }));
  });

  it('ativa um treino e desativa outro plano ativo do mesmo aluno', async () => {
    db.workout.findFirst.mockResolvedValue({ id: 'workout-old', studentId: 'student-1' });
    db.workout.update.mockResolvedValue({ id: 'workout-old', title: 'Treino antigo', active: true });

    const response = await request(createApp())
      .patch('/api/workouts/workout-old')
      .send({ active: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'workout-old', title: 'Treino antigo', active: true });
    expect(db.workout.updateMany).toHaveBeenCalledWith({
      where: { personalId: 'personal-1', studentId: 'student-1', active: true, NOT: { id: 'workout-old' } },
      data: { active: false },
    });
    expect(db.workout.update).toHaveBeenCalledWith({
      where: { id: 'workout-old' },
      data: { active: true },
      select: { id: true, title: true, active: true },
    });
  });

  it('permite desativar um treino sem alterar o histórico de outros planos', async () => {
    db.workout.findFirst.mockResolvedValue({ id: 'workout-active', studentId: 'student-1' });
    db.workout.update.mockResolvedValue({ id: 'workout-active', title: 'Treino A', active: false });

    const response = await request(createApp())
      .patch('/api/workouts/workout-active')
      .send({ active: false });

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(false);
    expect(db.workout.updateMany).not.toHaveBeenCalled();
    expect(db.workout.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'workout-active' },
      data: { active: false },
    }));
  });
});
