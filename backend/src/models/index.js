'use strict';
const { Sequelize } = require('sequelize');
const config = require('../config/database');

const env = process.env.NODE_ENV || 'development';
const dbConfig = config[env];

const sequelize = new Sequelize(
  dbConfig.database,
  dbConfig.username,
  dbConfig.password,
  dbConfig
);

const db = {};

// Registrar todos os models
const modelFiles = [
  require('./Tenant'),
  require('./User'),
  require('./Subscription'),
  require('./Conversation'),
  require('./Message'),
  require('./PaymentSchedule'),
  require('./Transaction'),
  require('./Invoice'),
  require('./Client'),
  require('./KnowledgeBase'),
  require('./Appointment'),
];

modelFiles.forEach((defineModel) => {
  const model = defineModel(sequelize, Sequelize.DataTypes);
  db[model.name] = model;
});

// Associações
Object.values(db).forEach((model) => {
  if (model.associate) {
    model.associate(db);
  }
});

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
