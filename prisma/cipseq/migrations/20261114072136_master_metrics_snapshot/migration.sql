-- CreateTable
CREATE TABLE "masterMetricsSnapshot" (
    "id" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "periods" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "masterMetricsSnapshot_pkey" PRIMARY KEY ("id")
);
