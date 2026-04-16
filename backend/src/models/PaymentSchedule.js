'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PaymentSchedule extends Model {
    static associate(models) {
      PaymentSchedule.belongsTo(models.Tenant, { foreignKey: 'tenant_id', as: 'tenant' });
      PaymentSchedule.hasMany(models.Transaction, { foreignKey: 'schedule_id', as: 'transactions' });
    }
  }

  PaymentSchedule.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      client_name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      client_email: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      client_phone: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      recurring_day: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Dia do mês para cobranças recorrentes mensais (1–31)',
      },
      description: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        defaultValue: 'BRL',
      },
      due_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      recurrence: {
        type: DataTypes.ENUM('once', 'weekly', 'monthly', 'yearly'),
        defaultValue: 'once',
      },
      notification_status: {
        type: DataTypes.ENUM('pending', 'sent', 'failed'),
        defaultValue: 'pending',
      },
      status: {
        type: DataTypes.ENUM('active', 'paused', 'completed', 'cancelled'),
        defaultValue: 'active',
      },
      payment_method: {
        type: DataTypes.ENUM('boleto', 'pix', 'credit_card', 'debit'),
        defaultValue: 'pix',
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'receivable',
        comment: 'receivable = a receber | payable = a pagar',
        validate: { isIn: [['receivable', 'payable']] },
      },
      category: {
        type: DataTypes.STRING(60),
        allowNull: true,
        comment: 'Ex: Serviço, Aluguel, Fornecedor, Mensalidade',
      },
      custom_message: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Mensagem personalizada exibida no corpo da notificação de cobrança via WhatsApp',
      },
      notify_time: {
        type: DataTypes.STRING(5),
        allowNull: true,
        comment: 'Horário do envio automático da cobrança (HH:MM, horário de Brasília)',
      },
      last_notified_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Data/hora do último envio automático realizado',
      },
    },
    {
      sequelize,
      modelName: 'PaymentSchedule',
      tableName: 'payment_schedules',
      underscored: true,
      timestamps: true,
      paranoid: true,
    }
  );

  return PaymentSchedule;
};
