'use strict';

const { MongoClient } = require('mongodb');
const config = require('./config');

/**
 * Lazy singleton Mongo connection + index bootstrap.
 *
 * Collections (created lazily on first write):
 *   - metrics_daily : one doc per (installId, date), counts accumulated via $inc
 *   - feedback      : one doc per user-submitted feedback
 */
let clientPromise = null;

async function getDb() {
  if (!clientPromise) {
    const client = new MongoClient(config.mongoUri, {
      // Keep the pool small; this service is light.
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
    });
    clientPromise = client.connect().then(async (c) => {
      const db = c.db(config.dbName);
      await ensureIndexes(db);
      console.log(`Mongo connected → db "${config.dbName}"`);
      return db;
    });
  }
  return clientPromise;
}

async function ensureIndexes(db) {
  // One document per install per day; the unique index makes the $inc upsert safe.
  await db.collection('metrics_daily').createIndex(
    { installId: 1, date: 1 },
    { unique: true, name: 'uniq_install_day' },
  );
  // Range queries for DAU/MAU/retention.
  await db.collection('metrics_daily').createIndex({ date: 1 }, { name: 'by_date' });
  await db.collection('metrics_daily').createIndex({ firstSeenAt: 1 }, { name: 'by_first_seen' });
  // Newest feedback first.
  await db.collection('feedback').createIndex({ submittedAt: -1 }, { name: 'by_submitted' });
}

module.exports = { getDb };
