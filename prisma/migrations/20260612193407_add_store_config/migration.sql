-- CreateTable
CREATE TABLE "StoreConfig" (
    "storeId" TEXT NOT NULL PRIMARY KEY,
    "conversionRate" REAL NOT NULL DEFAULT 1000,
    "updatedAt" DATETIME NOT NULL
);
