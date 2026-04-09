'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Invoice extends Model {
    static associate(models) {
      Invoice.belongsTo(models.Transaction, { foreignKey: 'transaction_id', as: 'transaction' });
    }
  }

  Invoice.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      transaction_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      number: {
        type: DataTypes.STRING,
        unique: true,
      },
      total: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
      },
      tax: {
        type: DataTypes.DECIMAL(12, 2),
        defaultValue: 0,
      },
      status: {
        type: DataTypes.ENUM('draft', 'issued', 'paid', 'overdue', 'cancelled'),
        defaultValue: 'draft',
      },
      pdf_url: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      issued_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      paid_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'Invoice',
      tableName: 'invoices',
    }
  );

  return Invoice;
};
