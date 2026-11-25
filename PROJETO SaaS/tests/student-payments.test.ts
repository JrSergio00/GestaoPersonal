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

const student = {
  id: 'student-1',
  name: 'Ana Silva',
  email: 'ana@example.com',
  active: true,
  lessonDurationMinutes: 60,
  schedules: [],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};
const db = {
  student: { findFirst: vi.fn() },
  extraPayment: { create: vi.fn(), findMany: vi.fn() },
  paymentParcel: { findFirst: vi.fn(), updateMany: vi.fn() },
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

describe('pagamentos de alunos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getScopedPrisma.mockReturnValue(db);
    db.student.findFirst.mockResolvedValue({ id: student.id });
    db.extraPayment.create.mockResolvedValue({
      id: 'payment-1',
      amount: { toString: () => '125.50' },
      paymentMethod: 'PIX',
      status: 'CONFIRMED',
    });
    db.paymentParcel.findFirst.mockResolvedValue({ id: 'parcel-1', status: 'PENDING' });
    db.paymentParcel.updateMany.mockResolvedValue({ count: 1 });
  });

  it('registra valor, forma e data como receita confirmada', async () => {
    const response = await request(createApp())
      .post('/api/students/student-1/payments')
      .send({ amount: 125.5, paymentMethod: 'PIX', paidAt: '2026-11-24' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: 'payment-1',
      amount: 125.5,
      paymentMethod: 'PIX',
      status: 'CONFIRMED',
      paidAt: '2026-11-24T12:00:00.000Z',
    });
    expect(mocks.getScopedPrisma).toHaveBeenCalledWith('personal-1');
    expect(db.extraPayment.create).toHaveBeenCalledWith({
      data: {
        personalId: 'personal-1',
        studentId: 'student-1',
        amount: '125.50',
        paymentMethod: 'PIX',
        dueDate: new Date('2026-11-24T12:00:00.000Z'),
        confirmedAt: new Date('2026-11-24T12:00:00.000Z'),
        status: 'CONFIRMED',
      },
    });
  });

  it('retorna o histórico de pagamentos do aluno dentro do tenant', async () => {
    const paidAt = new Date('2026-11-24T12:00:00.000Z');
    db.student.findFirst.mockResolvedValue(student);
    db.extraPayment.findMany.mockResolvedValue([{
      id: 'payment-1',
      amount: { toString: () => '125.50' },
      status: 'CONFIRMED',
      paymentMethod: 'PIX',
      dueDate: paidAt,
      confirmedAt: paidAt,
      createdAt: paidAt,
    }]);

    const response = await request(createApp()).get('/api/students/student-1');

    expect(response.status).toBe(200);
    expect(response.body.student).toMatchObject({ id: 'student-1', name: 'Ana Silva' });
    expect(response.body.payments).toEqual([{
      id: 'payment-1',
      amount: 125.5,
      status: 'CONFIRMED',
      paymentMethod: 'PIX',
      paidAt: paidAt.toISOString(),
    }]);
    expect(mocks.getScopedPrisma).toHaveBeenCalledWith('personal-1');
    expect(db.extraPayment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { studentId: 'student-1' },
    }));
  });

  it('rejeita data inválida, valor sem centavos válidos ou forma desconhecida', async () => {
    const response = await request(createApp())
      .post('/api/students/student-1/payments')
      .send({ amount: 10.001, paymentMethod: 'CHEQUE', paidAt: '2026-02-30' });

    expect(response.status).toBe(400);
    expect(db.student.findFirst).not.toHaveBeenCalled();
    expect(db.extraPayment.create).not.toHaveBeenCalled();
  });

  it('não registra pagamento para aluno fora do escopo', async () => {
    db.student.findFirst.mockResolvedValue(null);

    const response = await request(createApp())
      .post('/api/students/other-student/payments')
      .send({ amount: 80, paymentMethod: 'CASH', paidAt: '2026-11-24' });

    expect(response.status).toBe(404);
    expect(db.extraPayment.create).not.toHaveBeenCalled();
  });

  it('confirma uma parcela recorrente com data e forma de pagamento', async () => {
    const response = await request(createApp())
      .post('/api/finance/parcels/parcel-1/confirm')
      .send({ paymentMethod: 'PIX', paidAt: '2026-11-24' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: 'parcel-1',
      status: 'CONFIRMED',
      confirmedAt: '2026-11-24T12:00:00.000Z',
      paymentMethod: 'PIX',
    });
    expect(db.paymentParcel.findFirst).toHaveBeenCalledWith({
      where: { id: 'parcel-1' },
      select: { id: true, status: true },
    });
    expect(db.paymentParcel.updateMany).toHaveBeenCalledWith({
      where: { id: 'parcel-1', status: { in: ['PENDING', 'FAILED'] } },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date('2026-11-24T12:00:00.000Z'),
        paymentMethod: 'PIX',
      },
    });
  });

  it('não confirma parcelas inexistentes ou dados de pagamento inválidos', async () => {
    const invalid = await request(createApp())
      .post('/api/finance/parcels/parcel-1/confirm')
      .send({ paymentMethod: 'CHEQUE', paidAt: '2026-02-30' });
    expect(invalid.status).toBe(400);
    expect(db.paymentParcel.findFirst).not.toHaveBeenCalled();

    db.paymentParcel.findFirst.mockResolvedValue(null);
    const missing = await request(createApp())
      .post('/api/finance/parcels/other-tenant-parcel/confirm')
      .send({ paymentMethod: 'PIX', paidAt: '2026-11-24' });
    expect(missing.status).toBe(404);
    expect(db.paymentParcel.updateMany).not.toHaveBeenCalled();
  });

  it('não confirma novamente uma parcela já recebida', async () => {
    db.paymentParcel.findFirst.mockResolvedValue({ id: 'parcel-1', status: 'CONFIRMED' });
    const response = await request(createApp())
      .post('/api/finance/parcels/parcel-1/confirm')
      .send({ paymentMethod: 'PIX', paidAt: '2026-11-24' });

    expect(response.status).toBe(409);
    expect(db.paymentParcel.updateMany).not.toHaveBeenCalled();
  });
});
