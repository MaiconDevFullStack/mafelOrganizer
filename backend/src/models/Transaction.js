'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Transaction extends Model {
    static associate(models) {
      Transaction.belongsTo(models.PaymentSchedule, { foreignKey: 'schedule_id', as: 'schedule' });
      Transaction.hasOne(models.Invoice, { foreignKey: 'transaction_id', as: 'invoice' });
    }
  }

  Transaction.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      schedule_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('pending', 'success', 'failed', 'refunded'),
        defaultValue: 'pending',
      },
      psp_id: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      psp_response: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      attempts: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      processed_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'Transaction',
      tableName: 'transactions',
    }
  );

  return Transaction;
};
