CREATE TYPE "PaymentMethod" AS ENUM ('PIX', 'CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'OTHER');

ALTER TABLE "extra_payments"
ADD COLUMN "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'OTHER';
