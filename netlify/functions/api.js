require('dotenv').config();
const serverless = require('serverless-http');
const { createApp } = require('../../server/app');
const { connectDB } = require('../../server/db');

const app = createApp();
const expressHandler = serverless(app);
let dbConnection = null;

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false; // let the warm connection survive between invocations
  if (!dbConnection) dbConnection = connectDB();
  try {
    await dbConnection;
  } catch (e) {
    dbConnection = null; // don't keep retrying a cached failure forever
    throw e;
  }

  return expressHandler(event, context);
};
